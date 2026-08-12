'use strict';

const vscode = require('vscode');
const macroFormat = require('./macroFormat');
const ttlFormat = require('./ttlFormat');
const metaFormat = require('./metaFormat');

function activate(context) {
  context.subscriptions.push(MacroEditorProvider.register(context));
  context.subscriptions.push(TtlEditorProvider.register(context));
}

function deactivate() {}

/**
 * A minimal internal pub/sub whose fire() actually awaits every listener,
 * unlike vscode.EventEmitter (which dispatches fire-and-forget, matching how
 * real VS Code events behave). Used only for signals that are purely
 * internal to this extension - never for anything implementing a VS Code API
 * contract (those still use vscode.EventEmitter as required).
 */
class AsyncEmitter {
  constructor() {
    this._listeners = [];
  }
  get event() {
    return (listener) => {
      this._listeners.push(listener);
      return {
        dispose: () => {
          const i = this._listeners.indexOf(listener);
          if (i !== -1) {
            this._listeners.splice(i, 1);
          }
        }
      };
    };
  }
  async fire(value) {
    for (const listener of [...this._listeners]) {
      await listener(value);
    }
  }
  dispose() {
    this._listeners = [];
  }
}

/** Read both mcr.ttl and mcr_2.ttl (if present) and return all 40 book names, 1-based index. */
async function loadAllBookNames(dirUri) {
  const names = new Array(macroFormat.BOOKS_PER_CHARACTER).fill('');
  const halves = [
    { fileName: 'mcr.ttl', offset: 0 },
    { fileName: 'mcr_2.ttl', offset: 20 }
  ];
  for (const half of halves) {
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dirUri, half.fileName));
      const parsed = ttlFormat.parseTtlBuffer(Buffer.from(data));
      for (let i = 0; i < ttlFormat.RECORDS_PER_FILE; i++) {
        names[half.offset + i] = parsed.names[i];
      }
    } catch {
      // File doesn't exist (or isn't the expected size) - leave that half blank.
    }
  }
  return names;
}

/**
 * Load ".ffxi.meta" from the given directory, creating it with default
 * content if it doesn't exist yet. If it exists but isn't valid JSON, it is
 * left untouched on disk (never overwritten) and default values are used
 * in-memory only, so a person mid-editing it externally never loses work.
 */
async function loadOrCreateMetaFile(dirUri) {
  const metaUri = vscode.Uri.joinPath(dirUri, metaFormat.META_FILENAME);
  try {
    const data = await vscode.workspace.fs.readFile(metaUri);
    const parsed = metaFormat.parseMeta(Buffer.from(data).toString('utf8'));
    return { meta: parsed || metaFormat.defaultMetaObject(), uri: metaUri };
  } catch {
    const defaultObj = metaFormat.defaultMetaObject();
    await vscode.workspace.fs.writeFile(metaUri, Buffer.from(metaFormat.defaultMetaYaml(), 'utf8'));
    return { meta: defaultObj, uri: metaUri };
  }
}

/** Attach loaded (or newly-created) .ffxi.meta data onto a document instance. */
async function attachMetaData(document, uri) {
  const dirUri = vscode.Uri.joinPath(uri, '..');
  const result = await loadOrCreateMetaFile(dirUri);
  document.metaData = result.meta;
  document.metaUri = result.uri;
}

/**
 * Re-read .ffxi.meta from disk and update the document in place. Unlike the
 * mcr*.dat / .ttl auto-reload, this is never gated by the document's dirty
 * flag or the auto-reload checkbox - these description fields aren't edited
 * through this extension's UI at all, so there's nothing for an external
 * change to clobber.
 */
async function reloadMetaData(document) {
  try {
    const data = await vscode.workspace.fs.readFile(document.metaUri);
    const parsed = metaFormat.parseMeta(Buffer.from(data).toString('utf8'));
    if (parsed) {
      document.metaData = parsed;
    }
  } catch {
    // Transient read error or file briefly missing mid-write - keep the last known-good value.
  }
}

/**
 * Registry of book-name "listeners" (MacroDocuments and/or TtlDocument record
 * proxies), grouped by which book (1-40) they belong to. This lets an edit to
 * a book's name reach every other currently-open view of that book - a
 * different set's .dat tab, or the .ttl book-list view - immediately,
 * instead of only updating on disk at save time.
 *
 * Every entry just needs: { location: { bookNumber }, _applyExternalBookNameSync(value) }
 */
const documentsByBook = new Map(); // bookNumber -> Set<listener>

function registerDocument(listener) {
  if (!listener.location) {
    return;
  }
  const key = listener.location.bookNumber;
  if (!documentsByBook.has(key)) {
    documentsByBook.set(key, new Set());
  }
  documentsByBook.get(key).add(listener);
}

function unregisterDocument(listener) {
  if (!listener.location) {
    return;
  }
  const set = documentsByBook.get(listener.location.bookNumber);
  if (set) {
    set.delete(listener);
    if (set.size === 0) {
      documentsByBook.delete(listener.location.bookNumber);
    }
  }
}

/** Find another already-open MacroDocument for the same book, if any (used to seed a fresh document with a not-yet-saved name). */
function findOpenSiblingMacroDocument(bookNumber, exclude) {
  const set = documentsByBook.get(bookNumber);
  if (!set) {
    return null;
  }
  for (const listener of set) {
    if (listener !== exclude && listener instanceof MacroDocument) {
      return listener;
    }
  }
  return null;
}

/** Push a book-name change out to every other open view of the same book, live, awaiting each. */
async function propagateBookNameChange(bookNumber, newValue, source) {
  const set = documentsByBook.get(bookNumber);
  if (!set) {
    return;
  }
  for (const listener of set) {
    if (listener !== source) {
      await listener._applyExternalBookNameSync(newValue);
    }
  }
}

/** In-memory model for one open mcr*.dat file, with undo/redo support. */
class MacroDocument {
  static async create(uri, backupId) {
    const dataUri = backupId ? vscode.Uri.parse(backupId) : uri;
    let buffer = null;
    try {
      const fileData = await vscode.workspace.fs.readFile(dataUri);
      buffer = Buffer.from(fileData);
    } catch {
      // File doesn't exist yet: this is a brand-new (empty) macro set, reached
      // via the book/set navigation dropdowns rather than the file explorer.
      buffer = null;
    }
    const doc = new MacroDocument(uri, buffer);
    await doc._loadBookName();
    return doc;
  }

  constructor(uri, initialBuffer) {
    this.uri = uri;
    this.isNew = !initialBuffer;
    this.location = macroFormat.bookSetForFileName(uri.path.split('/').pop());

    const parsed = initialBuffer
      ? macroFormat.parseMacroSet(initialBuffer)
      : macroFormat.blankMacroSet();

    this.meta = { version: parsed.version, groupId: parsed.groupId };
    this.checksumInfo = {
      stored: parsed.storedChecksum,
      computed: parsed.computedChecksum,
      valid: parsed.checksumValid
    };
    this._macros = parsed.macros.map((m) => ({ slot: m.slot, name: m.name, lines: [...m.lines] }));

    this.bookName = '';
    this.ttlChecksumInfo = null;
    this._ttlExists = false;

    // Whether external on-disk changes should auto-refresh this tab; toggled
    // from the webview's "Auto reload" checkbox. Auto-reload is skipped
    // while this document has unsaved edits, so it never clobbers your work.
    this.autoReloadEnabled = true;
    this._dirty = false;

    this._onDidDispose = new vscode.EventEmitter();
    this.onDidDispose = this._onDidDispose.event;

    this._onDidChangeDocument = new vscode.EventEmitter();
    // Fired for VS Code's own dirty/undo-redo tracking (CustomDocumentEditEvent shape)
    this.onDidChangeContent = this._onDidChangeDocument.event;

    // Fired when this document's bookName changes for reasons *other* than
    // its own undo/redo edit stack - i.e. propagated in from a sibling tab
    // or the .ttl book-list view. Separate from onDidChangeContent so it
    // doesn't affect this document's own dirty/undo state. Uses AsyncEmitter
    // (not vscode.EventEmitter) so callers can actually await the resync.
    this._onBookNameSynced = new AsyncEmitter();
    this.onBookNameSynced = this._onBookNameSynced.event;
  }

  get macros() {
    return this._macros;
  }

  dispose() {
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
    this._onDidChangeDocument.dispose();
    this._onBookNameSynced.dispose();
  }

  async _loadBookName() {
    if (!this.location) {
      return;
    }

    // If another set from the same book is already open, its in-memory name
    // (possibly a not-yet-saved edit) is more up to date than disk.
    const sibling = findOpenSiblingMacroDocument(this.location.bookNumber, this);
    if (sibling) {
      this.bookName = sibling.bookName;
      this.ttlChecksumInfo = sibling.ttlChecksumInfo;
      this._ttlExists = sibling._ttlExists;
      return;
    }

    const { fileName, recordIndex } = ttlFormat.ttlLocationForBook(this.location.bookNumber);
    const ttlUri = vscode.Uri.joinPath(this.uri, '..', fileName);
    try {
      const data = await vscode.workspace.fs.readFile(ttlUri);
      const parsed = ttlFormat.parseTtlBuffer(Buffer.from(data));
      this.bookName = parsed.names[recordIndex];
      this.ttlChecksumInfo = {
        stored: parsed.storedChecksum,
        computed: parsed.computedChecksum,
        valid: parsed.checksumValid
      };
      this._ttlExists = true;
    } catch {
      this.bookName = '';
      this.ttlChecksumInfo = null;
      this._ttlExists = false;
    }
  }

  /** Apply a macro-field edit coming from the webview, and register it for undo/redo. */
  edit(index, field, lineIndex, newValue) {
    const macro = this._macros[index];
    const oldValue = field === 'name' ? macro.name : macro.lines[lineIndex];
    if (oldValue === newValue) {
      return;
    }

    const apply = (value) => {
      if (field === 'name') {
        macro.name = value;
      } else {
        macro.lines[lineIndex] = value;
      }
      this._dirty = true;
    };
    apply(newValue);

    const label = field === 'name'
      ? `Rename macro ${index + 1}`
      : `Edit macro ${index + 1} line ${lineIndex + 1}`;

    this._onDidChangeDocument.fire({
      document: this,
      label,
      undo: () => apply(oldValue),
      redo: () => apply(newValue)
    });
  }

  /** Apply a book-name edit, registered for undo/redo, and push it out to sibling views live.
   * Returns a promise that resolves once the initial propagation has completed, so callers
   * that want to wait for sibling tabs to be caught up can await it. */
  editBookName(newValue) {
    newValue = String(newValue || '').slice(0, ttlFormat.NAME_MAX_LENGTH);
    const oldValue = this.bookName;
    if (oldValue === newValue) {
      return Promise.resolve();
    }
    const apply = async (value) => {
      this.bookName = value;
      this._dirty = true;
      if (this.location) {
        await propagateBookNameChange(this.location.bookNumber, value, this);
      }
    };
    const initialApply = apply(newValue);

    this._onDidChangeDocument.fire({
      document: this,
      label: 'Rename macro book',
      undo: () => apply(oldValue),
      redo: () => apply(newValue)
    });

    return initialApply;
  }

  /** Called on sibling views when a *different* tab for the same book renames it. */
  async _applyExternalBookNameSync(newValue) {
    this.bookName = newValue;
    await this._onBookNameSynced.fire();
  }

  toBuffer() {
    return macroFormat.serializeMacroSet(this.meta, this._macros);
  }

  async save(targetUri) {
    const buffer = this.toBuffer();
    await vscode.workspace.fs.writeFile(targetUri, buffer);
    this.isNew = false;
    this.uri = targetUri;
    this._dirty = false;

    if (this.location) {
      await this._saveBookName();
    }
  }

  /** Re-read the relevant .ttl file fresh, patch just this book's record, and write it back. */
  async _saveBookName() {
    const { fileName, recordIndex } = ttlFormat.ttlLocationForBook(this.location.bookNumber);
    const ttlUri = vscode.Uri.joinPath(this.uri, '..', fileName);

    let meta = { version: 1, groupId: this.meta.groupId };
    let names = ttlFormat.emptyNames();
    try {
      const data = await vscode.workspace.fs.readFile(ttlUri);
      const parsed = ttlFormat.parseTtlBuffer(Buffer.from(data));
      meta = { version: parsed.version, groupId: parsed.groupId };
      names = parsed.names;
    } catch {
      // .ttl doesn't exist yet - create it fresh, seeded with this set's group id.
    }

    // Skip creating a brand-new .ttl file just because it's empty and never existed.
    if (!this._ttlExists && this.bookName === '') {
      return;
    }

    names[recordIndex] = this.bookName;
    const newBuffer = ttlFormat.serializeTtlBuffer(meta, names);
    await vscode.workspace.fs.writeFile(ttlUri, newBuffer);

    const reparsed = ttlFormat.parseTtlBuffer(newBuffer);
    this.ttlChecksumInfo = {
      stored: reparsed.storedChecksum,
      computed: reparsed.computedChecksum,
      valid: reparsed.checksumValid
    };
    this._ttlExists = true;
  }

  async revert() {
    let buffer = null;
    try {
      const fileData = await vscode.workspace.fs.readFile(this.uri);
      buffer = Buffer.from(fileData);
    } catch {
      buffer = null;
    }
    const parsed = buffer ? macroFormat.parseMacroSet(buffer) : macroFormat.blankMacroSet();
    this.isNew = !buffer;
    this.meta = { version: parsed.version, groupId: parsed.groupId };
    this.checksumInfo = {
      stored: parsed.storedChecksum,
      computed: parsed.computedChecksum,
      valid: parsed.checksumValid
    };
    this._macros = parsed.macros.map((m) => ({ slot: m.slot, name: m.name, lines: [...m.lines] }));
    this._dirty = false;
    await this._loadBookName();
  }

  async backup(destination) {
    await vscode.workspace.fs.writeFile(destination, this.toBuffer());
    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch {
          // best-effort cleanup
        }
      }
    };
  }
}

/** In-memory model for one open mcr.ttl / mcr_2.ttl file: the 20 book names it holds. */
class TtlDocument {
  static async create(uri, backupId) {
    const dataUri = backupId ? vscode.Uri.parse(backupId) : uri;
    let parsed = null;
    try {
      const data = await vscode.workspace.fs.readFile(dataUri);
      parsed = ttlFormat.parseTtlBuffer(Buffer.from(data));
    } catch {
      parsed = null;
    }
    return new TtlDocument(uri, parsed);
  }

  constructor(uri, parsed) {
    this.uri = uri;
    const fileName = uri.path.split('/').pop();
    this.bookOffset = /mcr_2\.ttl$/i.test(fileName) ? 20 : 0; // 0 for mcr.ttl (books 1-20), 20 for mcr_2.ttl (books 21-40)
    this.isNew = !parsed;

    this.meta = parsed
      ? { version: parsed.version, groupId: parsed.groupId }
      : { version: 1, groupId: '00000000' };
    this.checksumInfo = parsed
      ? { stored: parsed.storedChecksum, computed: parsed.computedChecksum, valid: parsed.checksumValid }
      : { stored: null, computed: null, valid: null };
    this.names = parsed ? [...parsed.names] : ttlFormat.emptyNames();

    this._dirty = false;
    this.autoReloadEnabled = true;

    this._onDidDispose = new vscode.EventEmitter();
    this.onDidDispose = this._onDidDispose.event;
    this._onDidChangeDocument = new vscode.EventEmitter();
    this.onDidChangeContent = this._onDidChangeDocument.event;
    this._onRecordSynced = new AsyncEmitter(); // fires with the changed record index
    this.onRecordSynced = this._onRecordSynced.event;

    // One registry proxy per book/record, so a rename from an individual
    // .dat tab reaches this list view the same way it reaches other tabs.
    this._recordProxies = this.names.map((_, i) => ({
      location: { bookNumber: this.bookOffset + i + 1 },
      _applyExternalBookNameSync: async (newValue) => {
        this.names[i] = newValue;
        await this._onRecordSynced.fire(i);
      }
    }));
  }

  bookNumberForIndex(i) {
    return this.bookOffset + i + 1;
  }

  registerProxies() {
    this._recordProxies.forEach(registerDocument);
  }

  unregisterProxies() {
    this._recordProxies.forEach(unregisterDocument);
  }

  dispose() {
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
    this._onDidChangeDocument.dispose();
    this._onRecordSynced.dispose();
  }

  /** Rename book at record `index`, registered for undo/redo, propagated live to any open .dat tab for that book.
   * Returns a promise resolving once the initial propagation completes. */
  editRecord(index, newValue) {
    newValue = String(newValue || '').slice(0, ttlFormat.NAME_MAX_LENGTH);
    const oldValue = this.names[index];
    if (oldValue === newValue) {
      return Promise.resolve();
    }
    const bookNumber = this.bookNumberForIndex(index);
    const apply = async (value) => {
      this.names[index] = value;
      this._dirty = true;
      await propagateBookNameChange(bookNumber, value, this._recordProxies[index]);
    };
    const initialApply = apply(newValue);

    this._onDidChangeDocument.fire({
      document: this,
      label: `Rename Book${macroFormat.pad2(bookNumber)}`,
      undo: () => apply(oldValue),
      redo: () => apply(newValue)
    });

    return initialApply;
  }

  toBuffer() {
    return ttlFormat.serializeTtlBuffer(this.meta, this.names);
  }

  async save(targetUri) {
    const buffer = this.toBuffer();
    await vscode.workspace.fs.writeFile(targetUri, buffer);
    this.uri = targetUri;
    this.isNew = false;
    this._dirty = false;
    const reparsed = ttlFormat.parseTtlBuffer(buffer);
    this.checksumInfo = {
      stored: reparsed.storedChecksum,
      computed: reparsed.computedChecksum,
      valid: reparsed.checksumValid
    };
  }

  async revert() {
    let parsed = null;
    try {
      const data = await vscode.workspace.fs.readFile(this.uri);
      parsed = ttlFormat.parseTtlBuffer(Buffer.from(data));
    } catch {
      parsed = null;
    }
    this.isNew = !parsed;
    this.meta = parsed
      ? { version: parsed.version, groupId: parsed.groupId }
      : { version: 1, groupId: '00000000' };
    this.checksumInfo = parsed
      ? { stored: parsed.storedChecksum, computed: parsed.computedChecksum, valid: parsed.checksumValid }
      : { stored: null, computed: null, valid: null };
    this.names = parsed ? [...parsed.names] : ttlFormat.emptyNames();
    this._dirty = false;
  }

  async backup(destination) {
    await vscode.workspace.fs.writeFile(destination, this.toBuffer());
    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch {
          // best-effort cleanup
        }
      }
    };
  }
}

class MacroEditorProvider {
  static register(context) {
    const provider = new MacroEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(
      MacroEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false
      }
    );
  }

  constructor(context) {
    this.context = context;
    this._onDidChangeCustomDocument = new vscode.EventEmitter();
    this.onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;
  }

  async openCustomDocument(uri, openContext) {
    const document = await MacroDocument.create(uri, openContext.backupId);
    document.onDidChangeContent((e) => this._onDidChangeCustomDocument.fire(e));
    document.onDidDispose(() => unregisterDocument(document));
    registerDocument(document);
    await attachMetaData(document, uri);
    return document;
  }

  async resolveCustomEditor(document, webviewPanel) {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = this._getHtml(webviewPanel.webview);

    const postState = async () => {
      const dirUri = vscode.Uri.joinPath(document.uri, '..');
      let allBookNames = [];
      let bookDescription = '';
      let ctrlDescription = '';
      let altDescription = '';
      if (document.location) {
        allBookNames = await loadAllBookNames(dirUri);
        // Reflect this document's own (possibly unsaved) book name immediately,
        // in case it's newer than what's on disk.
        allBookNames[document.location.bookNumber - 1] = document.bookName;

        bookDescription = metaFormat.getBookDescription(document.metaData, document.location.bookNumber);
        ctrlDescription = metaFormat.getMacrosetDescription(
          document.metaData, document.location.bookNumber, document.location.setNumber, 'ctrl'
        );
        altDescription = metaFormat.getMacrosetDescription(
          document.metaData, document.location.bookNumber, document.location.setNumber, 'alt'
        );
      }

      webviewPanel.webview.postMessage({
        type: 'init',
        fileName: document.uri.path.split('/').pop(),
        isNew: document.isNew,
        meta: document.meta,
        checksumInfo: document.checksumInfo,
        macros: document.macros,
        location: document.location,
        bookName: document.bookName,
        ttlChecksumInfo: document.ttlChecksumInfo,
        allBookNames,
        bookDescription,
        ctrlDescription,
        altDescription
      });
    };

    // Re-sync whenever this tab becomes visible again - fixes the case where
    // VS Code reuses an already-open tab (instead of re-resolving it) when
    // navigating back to a file, which would otherwise leave stale dropdown
    // selections and an out-of-date book name on screen.
    webviewPanel.onDidChangeViewState(async () => {
      if (webviewPanel.visible) {
        await postState();
      }
    });

    // Re-sync immediately when a sibling view (different set, same book, or
    // the .ttl book-list view) renames the book.
    document.onBookNameSynced(async () => {
      await postState();
    });

    // Auto-reload: watch this set's own file, and its book's .ttl file, for
    // external changes (e.g. the game client itself writing macros while
    // running). Only reload while there are no unsaved edits in this tab.
    const dirUri = vscode.Uri.joinPath(document.uri, '..');
    const mcrFileName = document.uri.path.split('/').pop();
    const mcrWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dirUri, mcrFileName),
      false, false, true
    );
    const reloadMcr = async () => {
      if (!document.autoReloadEnabled || document._dirty) {
        return;
      }
      await document.revert();
      await postState();
    };
    mcrWatcher.onDidChange(reloadMcr);
    mcrWatcher.onDidCreate(reloadMcr);

    let ttlWatcher = null;
    if (document.location) {
      const { fileName: ttlFileName } = ttlFormat.ttlLocationForBook(document.location.bookNumber);
      ttlWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(dirUri, ttlFileName),
        false, false, true
      );
      const reloadTtl = async () => {
        if (!document.autoReloadEnabled || document._dirty) {
          return;
        }
        await document._loadBookName();
        await postState();
      };
      ttlWatcher.onDidChange(reloadTtl);
      ttlWatcher.onDidCreate(reloadTtl);
    }

    // .ffxi.meta descriptions always refresh on change - they aren't edited
    // through this extension's UI, so there's nothing for an external change
    // to clobber, and no need to gate this on the auto-reload checkbox.
    const metaWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dirUri, metaFormat.META_FILENAME),
      false, false, true
    );
    const reloadMeta = async () => {
      await reloadMetaData(document);
      await postState();
    };
    metaWatcher.onDidChange(reloadMeta);
    metaWatcher.onDidCreate(reloadMeta);

    webviewPanel.onDidDispose(() => {
      mcrWatcher.dispose();
      if (ttlWatcher) {
        ttlWatcher.dispose();
      }
      metaWatcher.dispose();
    });

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          await postState();
          break;
        case 'edit':
          document.edit(message.index, message.field, message.lineIndex, message.value);
          break;
        case 'editBookName':
          await document.editBookName(message.value);
          break;
        case 'setAutoReload':
          document.autoReloadEnabled = !!message.value;
          break;
        case 'openExecScript': {
          const scriptsDir = metaFormat.getScriptsDir(document.metaData);
          const scriptPath = metaFormat.joinAbsolutePath(scriptsDir, `${message.scriptName}.txt`);
          // Preserve the current document's scheme/authority (so this works the
          // same over Remote-SSH: scripts_dir is a path on that same remote host).
          const scriptUri = document.uri.with({ path: scriptPath });
          try {
            try {
              await vscode.workspace.fs.stat(scriptUri);
            } catch {
              await vscode.workspace.fs.writeFile(scriptUri, new Uint8Array());
            }
            const textDoc = await vscode.workspace.openTextDocument(scriptUri);
            await vscode.window.showTextDocument(textDoc, { preview: false });
          } catch (err) {
            vscode.window.showErrorMessage(`Couldn't open script file ${scriptPath}: ${err.message || err}`);
          }
          break;
        }
        case 'navigate': {
          if (!document.location) {
            return;
          }
          const fileName = macroFormat.fileNameForBookSet(message.bookNumber, message.setNumber);
          if (fileName === document.uri.path.split('/').pop()) {
            return; // already viewing this set
          }
          const targetUri = vscode.Uri.joinPath(document.uri, '..', fileName);
          try {
            await vscode.commands.executeCommand(
              'vscode.openWith',
              targetUri,
              MacroEditorProvider.viewType,
              webviewPanel.viewColumn
            );
          } catch (err) {
            vscode.window.showErrorMessage(`Couldn't open ${fileName}: ${err.message || err}`);
          }
          break;
        }
        default:
          break;
      }
    });
  }

  async saveCustomDocument(document) {
    await document.save(document.uri);
  }

  async saveCustomDocumentAs(document, destination) {
    await document.save(destination);
  }

  async revertCustomDocument(document) {
    await document.revert();
  }

  async backupCustomDocument(document, context) {
    return document.backup(context.destination);
  }

  _getHtml(webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'style.css')
    );
    const nonce = String(Date.now());

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>FFXI Macro Set</title>
</head>
<body>
  <div id="meta"></div>
  <div id="macros"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

MacroEditorProvider.viewType = 'ffxiMacro.editor';

class TtlEditorProvider {
  static register(context) {
    const provider = new TtlEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(
      TtlEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false
      }
    );
  }

  constructor(context) {
    this.context = context;
    this._onDidChangeCustomDocument = new vscode.EventEmitter();
    this.onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;
  }

  async openCustomDocument(uri, openContext) {
    const document = await TtlDocument.create(uri, openContext.backupId);
    document.onDidChangeContent((e) => this._onDidChangeCustomDocument.fire(e));
    document.onDidDispose(() => document.unregisterProxies());
    document.registerProxies();
    await attachMetaData(document, uri);
    return document;
  }

  async resolveCustomEditor(document, webviewPanel) {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = this._getHtml(webviewPanel.webview);

    const postState = () => {
      const descriptions = document.names.map((_, i) =>
        metaFormat.getBookDescription(document.metaData, document.bookNumberForIndex(i))
      );
      webviewPanel.webview.postMessage({
        type: 'init',
        fileName: document.uri.path.split('/').pop(),
        isNew: document.isNew,
        meta: document.meta,
        checksumInfo: document.checksumInfo,
        bookOffset: document.bookOffset,
        names: document.names,
        descriptions
      });
    };

    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.visible) {
        postState();
      }
    });
    document.onRecordSynced(() => postState());

    const dirUri = vscode.Uri.joinPath(document.uri, '..');
    const fileName = document.uri.path.split('/').pop();
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dirUri, fileName),
      false, false, true
    );
    const reload = async () => {
      if (!document.autoReloadEnabled || document._dirty) {
        return;
      }
      await document.revert();
      postState();
    };
    watcher.onDidChange(reload);
    watcher.onDidCreate(reload);

    const metaWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dirUri, metaFormat.META_FILENAME),
      false, false, true
    );
    const reloadMeta = async () => {
      await reloadMetaData(document);
      postState();
    };
    metaWatcher.onDidChange(reloadMeta);
    metaWatcher.onDidCreate(reloadMeta);

    webviewPanel.onDidDispose(() => {
      watcher.dispose();
      metaWatcher.dispose();
    });

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          postState();
          break;
        case 'editRecord':
          await document.editRecord(message.index, message.value);
          break;
        case 'setAutoReload':
          document.autoReloadEnabled = !!message.value;
          break;
        case 'viewBook': {
          const targetFileName = macroFormat.fileNameForBookSet(message.bookNumber, 1);
          const targetUri = vscode.Uri.joinPath(dirUri, targetFileName);
          try {
            await vscode.commands.executeCommand(
              'vscode.openWith',
              targetUri,
              MacroEditorProvider.viewType,
              webviewPanel.viewColumn
            );
          } catch (err) {
            vscode.window.showErrorMessage(`Couldn't open ${targetFileName}: ${err.message || err}`);
          }
          break;
        }
        default:
          break;
      }
    });
  }

  async saveCustomDocument(document) {
    await document.save(document.uri);
  }

  async saveCustomDocumentAs(document, destination) {
    await document.save(destination);
  }

  async revertCustomDocument(document) {
    await document.revert();
  }

  async backupCustomDocument(document, context) {
    return document.backup(context.destination);
  }

  _getHtml(webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'ttlView.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'style.css')
    );
    const nonce = String(Date.now());

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>FFXI Macro Book List</title>
</head>
<body>
  <div id="meta"></div>
  <div id="books"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

TtlEditorProvider.viewType = 'ffxiMacro.bookListEditor';

module.exports = {
  activate,
  deactivate,
  // Exported for local logic testing only; VS Code only calls activate/deactivate.
  _test: {
    MacroDocument, TtlDocument, MacroEditorProvider, TtlEditorProvider, documentsByBook,
    loadOrCreateMetaFile, attachMetaData
  }
};
