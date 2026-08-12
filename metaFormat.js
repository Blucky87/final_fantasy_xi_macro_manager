// Logic for the ".ffxi.meta" sidecar file that lives alongside a
// character's mcr*.dat / mcr*.ttl files. One file covers the whole
// directory (all 40 books), unlike mcr.ttl/mcr_2.ttl which are split.
//
// File format is YAML - but only a small, deliberate subset of it, since
// this extension has no build step and pulling in a real YAML library would
// mean requiring `npm install` before F5 works. What's supported: nested
// "key: value" scalars and "key:" block headers, at any depth, as long as
// each nesting level is indented exactly 2 spaces deeper than its parent.
// Values may be double- or single-quoted (double-quoted values use standard
// JSON string escaping). Anything outside that shape (lists, multi-line
// strings, anchors, inconsistent indentation, etc.) causes parseMeta() to
// return null rather than guess wrong, so the extension falls back to
// in-memory defaults instead of ever silently misreading (or overwriting) a
// file someone hand-wrote something fancier in.
//
// Schema:
//
//   scripts_dir: /home/test/xyz
//   books:
//     1:
//       description: Main WAR/SAM tank book
//       sets:
//         1:
//           ctrl: Standard tanking rotation, TP building
//           alt: Gear swaps - TP phase / WS phase
//         2:
//           ctrl: "Provoke: emergency hate reset macros"
//           alt: Defensive gear - Utsusemi, evasion set
//     10:
//       description: Endgame WHM healing book
//
// Book and set numbers are plain (unpadded) numbers used as map keys - the
// "Book01" zero-padded display form is purely a UI concern, generated at
// render time, not stored in the file.
//
// Nothing in this file touches the filesystem directly - that lives in
// extension.js so this module stays trivially unit-testable.

'use strict';

const DEFAULT_SCRIPTS_DIR = '/home/test/xyz';
const META_FILENAME = '.ffxi.meta';

function defaultMetaObject() {
  return { scripts_dir: DEFAULT_SCRIPTS_DIR };
}

/** Encode a single scalar value as a YAML value, quoting only when necessary. */
function encodeScalar(value) {
  const str = String(value === null || value === undefined ? '' : value);
  const needsQuoting =
    str === '' ||
    /^\s|\s$/.test(str) ||
    /^["'>|*&!%#,[\]{}]/.test(str) ||
    /:(\s|$)/.test(str) ||
    /#/.test(str) ||
    /\n/.test(str);
  return needsQuoting ? JSON.stringify(str) : str;
}

/** Decode a single YAML scalar value (the part after "key: "). */
function decodeScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return '';
  }
  if (trimmed[0] === '"') {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (trimmed.length >= 2 && trimmed[0] === "'" && trimmed[trimmed.length - 1] === "'") {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Recursively write `obj` as indented YAML lines into the given array. */
function writeLines(obj, depth, lines) {
  const pad = '  '.repeat(depth);
  for (const [key, value] of Object.entries(obj || {})) {
    if (isPlainObject(value)) {
      lines.push(`${pad}${key}:`);
      writeLines(value, depth + 1, lines);
    } else {
      lines.push(`${pad}${key}: ${encodeScalar(value)}`);
    }
  }
}

/** Serialize a plain object (arbitrary depth, string leaf values) to YAML text. */
function stringifyMeta(obj) {
  const lines = [];
  writeLines(obj, 0, lines);
  return `${lines.join('\n')}\n`;
}

function defaultMetaYaml() {
  return stringifyMeta(defaultMetaObject());
}

/**
 * Parse .ffxi.meta YAML text (our supported subset only). Returns null
 * (rather than throwing, or guessing) if it isn't in that subset, so callers
 * can choose not to overwrite a file they can't confidently understand.
 *
 * Nesting depth is unlimited, but each level must be indented exactly 2
 * spaces deeper than its parent - tracked with a small stack rather than
 * hardcoding specific depths, so "books -> N -> sets -> N -> ctrl/alt" (4
 * levels deep) works the same way 1-level nesting does.
 */
function parseMeta(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const lines = text.split(/\r\n|\r|\n/);
  const root = {};
  const stack = [{ indent: -2, obj: root }]; // sentinel root frame, so top-level keys land at indent 0

  for (const rawLine of lines) {
    if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) {
      continue;
    }
    const indentMatch = /^( *)(.*)$/.exec(rawLine);
    const indent = indentMatch[1].length;
    const content = indentMatch[2];

    if (indent % 2 !== 0) {
      return null; // Only even (2-space-multiple) indentation is supported.
    }

    const kv = /^([^:\s][^:]*):\s?(.*)$/.exec(content);
    if (!kv) {
      return null; // Doesn't look like our supported subset.
    }
    const key = kv[1].trim();
    const rest = kv[2];

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parentFrame = stack[stack.length - 1];

    if (indent !== parentFrame.indent + 2) {
      return null; // Inconsistent/unsupported indentation relative to its parent.
    }

    if (rest === '') {
      const child = {};
      parentFrame.obj[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parentFrame.obj[key] = decodeScalar(rest);
    }
  }

  return root;
}

function getScriptsDir(meta) {
  if (meta && typeof meta.scripts_dir === 'string' && meta.scripts_dir.trim() !== '') {
    return meta.scripts_dir;
  }
  return DEFAULT_SCRIPTS_DIR;
}

function getBookMeta(meta, bookNumber) {
  const books = isPlainObject(meta && meta.books) ? meta.books : {};
  const entry = books[String(bookNumber)];
  return isPlainObject(entry) ? entry : {};
}

function getBookDescription(meta, bookNumber) {
  const bm = getBookMeta(meta, bookNumber);
  return typeof bm.description === 'string' ? bm.description : '';
}

/** group is 'ctrl' or 'alt'; setNumber is 1-10. */
function getMacrosetDescription(meta, bookNumber, setNumber, group) {
  const bm = getBookMeta(meta, bookNumber);
  const sets = isPlainObject(bm.sets) ? bm.sets : {};
  const setEntry = sets[String(setNumber)];
  return isPlainObject(setEntry) && typeof setEntry[group] === 'string' ? setEntry[group] : '';
}

/** Detect an "/exec <name>" macro line, returning the script base name (no .txt), or null. */
function execScriptNameFromLine(line) {
  const match = /^\s*\/exec\s+(\S+)/i.exec(line || '');
  if (!match) {
    return null;
  }
  return match[1].replace(/\.txt$/i, '');
}

/** Join an absolute directory path with a filename, tolerating a trailing slash on the dir. */
function joinAbsolutePath(dir, name) {
  return `${String(dir).replace(/\/+$/, '')}/${name}`;
}

module.exports = {
  DEFAULT_SCRIPTS_DIR,
  META_FILENAME,
  defaultMetaObject,
  defaultMetaYaml,
  stringifyMeta,
  parseMeta,
  getScriptsDir,
  getBookMeta,
  getBookDescription,
  getMacrosetDescription,
  execScriptNameFromLine,
  joinAbsolutePath
};
