# FFXI Macro Editor (VS Code extension)

Out-of-game editor for Final Fantasy XI `mcr*.dat` macro set files and their
`mcr.ttl` / `mcr_2.ttl` book-name files.

## Macro set editor (`mcr*.dat`)

Opening any file matching `mcr*.dat` (e.g. `mcr.dat`, `mcr1.dat`, `mcr20.dat`)
shows a custom editor with 20 macro slots (Ctrl+1..0, Alt+1..0), split
across a **Ctrl Bar / Alt Bar tab pair** at the top of the macro list, each
with an editable name (max **8 characters**, the in-game display limit) and
6 command lines (max 60 characters each), instead of raw bytes.

At the top of the editor:

- **Book dropdown** — lists all 40 macro books as `Name (BookNN)`, reading
  names live from `mcr.ttl` (books 1–20) / `mcr_2.ttl` (books 21–40) in the
  same folder. Picking a different book always jumps to that book's set #1.
- **Set dropdown** — `#1`–`#10`, the 10 sets within the currently selected
  book.
- **Book name field** — editable, max **15 characters** (the 16-byte record
  is null-terminated, so 1 byte is reserved for that). Saving (Ctrl+S) writes
  the change back into the correct `.ttl` file, patching just that one
  record and recomputing its checksum, without touching the other 19 book
  names in that file.
- **Auto reload checkbox** — on by default. When the running game client (or
  anything else) writes to this set's `.dat` file or its book's `.ttl` file
  while the tab is open, the view refreshes automatically. It always pauses
  itself while the tab has unsaved edits, so it can never silently overwrite
  something you're in the middle of typing — turn it off if you'd rather
  control refreshes manually regardless.

Because each `mcr*.dat` is a separate file on disk, switching book/set via the
dropdowns opens (or focuses, if already open) that file's own tab — it
doesn't rewrite the current tab in place. Every tab re-syncs its own dropdown
selections and book name whenever it regains focus, so switching back to an
already-open tab never shows stale state. If you navigate to a book/set that
has no file on disk yet, the editor opens a blank template (marked "unsaved
new set") rather than erroring.

## Book list editor (`mcr.ttl` / `mcr_2.ttl`)

Opening `mcr.ttl` or `mcr_2.ttl` directly shows a simple list of the 20 books
that file covers (global books 1–20, or 21–40), each with:

- An editable name field (same 15-character limit as above).
- A **View** button that opens that book's set #1 in the macro set editor.
- A description line (see `.ffxi.meta` below), shown inside that book's own
  bordered row if one is set.

Renaming a book here updates it live in any already-open `.dat` tab for that
book, and vice versa — rename a book from a macro-set tab and any open
book-list view (or sibling set tab) picks it up immediately, before either
side is even saved. It has its own Auto reload checkbox too, for changes the
game writes to the `.ttl` file directly.

## `.ffxi.meta` — descriptions and script folder

Every time a `.dat` or `.ttl` file is opened, the extension checks the same
folder for a `.ffxi.meta` YAML file and **creates it with defaults if it
doesn't exist**:

```yaml
scripts_dir: /home/test/xyz
```

You can hand-edit this file to add a `books:` block, keyed by plain book
number, to add:

- a `description:` field — shown under the **Book name** field on every set
  of that book, and inside that book's row in the `.ttl` book-list view.
- a `sets:` block, keyed by plain set number (1–10), each with `ctrl:` /
  `alt:` fields — shown under the **Ctrl Bar** / **Alt Bar** headings on
  that specific set's page.

Example covering book 1 (with per-set notes on sets 1 and 2) and book 10
(book-level description only):

```yaml
scripts_dir: /home/test/xyz
books:
  1:
    description: Main warrior book
    sets:
      1:
        ctrl: Tanking rotation
        alt: Gear swaps for TP/WS
      2:
        ctrl: "Provoke: emergency hate reset macros"
  10:
    description: Endgame WHM healing book
```

Book/set numbers are unpadded (`1`, not `Book01` or `01`) — the zero-padded
`BookNN` form you see in the UI is generated at display time, not stored in
the file.

**This is a minimal YAML subset, not a full YAML parser** — deliberately, so
the extension needs no external dependency and no `npm install` step. It
supports nested `key: value` scalars and `key:` block headers at *any*
depth, as long as each level is indented exactly 2 spaces deeper than its
parent — no lists, no multi-line strings, no anchors. Values with a colon, a
`#`, or leading/trailing whitespace need double quotes (standard JSON-style
escaping), e.g. `ctrl: "Provoke: emergency hate reset macros"`. If the
file's content falls outside this subset, it's left completely untouched on
disk (never overwritten) and the extension just falls back to defaults in
memory until it's valid again.

These description fields aren't editable from the extension's UI — they're
meant to be maintained by hand (or by your own tooling) in `.ffxi.meta`
itself. The extension **always** picks up changes to this file live, in any
open tab, regardless of the Auto reload checkbox or whether that tab has
unsaved macro edits — since nothing in the UI writes to this file, there's
never anything for an external change to conflict with.

### `/exec` lines and the Open button

Any macro line matching `/exec <name>` (FFXI's syntax for running a script)
is shown a little narrower than other lines, with an **Open** button after
it. Clicking it opens `<scripts_dir>/<name>.txt` in a normal VS Code text
editor tab — creating an empty file first if one doesn't exist yet. This
respects Remote-SSH: `scripts_dir` is resolved on the same host as the
`.dat`/`.ttl` file you're viewing, not necessarily your local machine.

## Format assumptions

Saving (Ctrl+S) re-serializes the macro set (or book-name file) and
**recomputes the MD5 checksum** stored in its header (bytes 8–23), on the
assumption, cross-checked against the open-source POLUtils macro editor's
source, that this field is an MD5 of the bytes that follow the 24-byte
header. Undo/redo and the dirty-file indicator are wired up through VS
Code's standard custom-editor document model, for macro-field, book-name,
and book-list edits alike.

**Works with remote (SSH/WSL/Containers) workspaces.** The extension is
pinned to run locally (`"extensionKind": ["ui"]` in `package.json`) but reads
and writes files entirely through `vscode.workspace.fs`, which transparently
proxies to remote filesystems — so it works the same whether the folder is
local or opened over Remote-SSH.

## Try it (no build step required)

1. Open this folder (`ffxi-macro-editor/`) in VS Code.
2. Press `F5` (or Run → Start Debugging). This launches an **Extension
   Development Host** window with the extension active.
3. In that new window, open a folder containing your `mcr*.dat` files (e.g.
   your FFXI `USER/<charid>/` folder, or copies of it — **work on copies
   first**, see warning below).
4. Click on `mcr1.dat`, `mcr20.dat`, etc. in the Explorer. It should open in
   the macro editor instead of as raw binary/text.
5. Edit a macro name or line, then `Ctrl+S` to save.

## ⚠️ Before pointing this at real character data

- **Back up your `USER/<charid>` folder first.** This is a small, fast
  reverse-engineered spec, not something Square Enix published — the
  checksum assumption in particular is unverified against the live game.
- Close FFXI before editing files it might have open/cached.
- Test the round-trip on a copy: open a file, save without changes, and
  diff it against the original. It should be byte-identical (or differ
  only if the checksum was previously invalid).

## Known limitations / next steps

- **Encoding**: text fields (macro lines, macro names, book names) are
  read/written as Latin-1 (1 byte per character). Japanese (Shift-JIS) text
  is not yet supported.
- **Checksum assumption cross-checked, not 100% proven**: POLUtils' own
  source describes bytes 8–23 as an MD5 of the data that follows, computed
  the same way we do it. That's good corroboration, but it's still worth
  confirming against one of your own real files before fully trusting saves:
  `md5(bytes[24:7624]) == bytes[8:24]`.
- **Header bytes 4–7 ("group id") are genuinely uncertain.** We treat them as
  a per-character identifier; POLUtils' own comment calls the same field
  "Unknown - sometimes zero, sometimes 0x80000000" and always writes 0 on
  save. Neither is confirmed. We preserve whatever value was already in the
  file when saving, so this shouldn't matter unless you're creating a
  brand-new set from scratch via the navigation dropdowns (see below).
- **New sets get `groupId = 00000000`.** When you navigate to a book/set that
  has no file yet, there's no existing header to copy a group id from, so a
  placeholder of all-zeros is used. If that field does matter to the game
  client, you may want to instead duplicate an existing set's file and edit
  it, rather than creating one from scratch this way, until this is nailed
  down.
- **Save As** for a macro set only updates the `.ttl` book name relative to
  the *original* file's folder, not the destination folder — fine for normal
  same-folder saves, but not for "Save As" into a different directory.
- **Auto reload doesn't merge conflicts.** If two different open tabs for the
  *same book* both rename it independently without saving, the later edit
  wins in the live-sync (last-write-wins); it doesn't attempt to detect or
  warn about the conflict. This is a rare scenario for solo, personal use.
- **`.ffxi.meta` descriptions are read-only from the UI.** There's currently
  no in-app way to type a book/macroset description — only to view one
  that's already in the file. Adding inline editing for these (mirroring how
  book names work) would be a natural next step.
- **`.ffxi.meta`'s YAML support is intentionally minimal** (see above) — it
  isn't a general-purpose YAML parser, just enough to cover the shape this
  extension itself generates and expects.
- No validation yet on line length beyond the 60-char field limit (e.g. not
  checking that `<t>`/`<mb>` etc. auto-translate tags are well-formed).
- `mb.dat`, `mix.dat`, `moix.dat` remain undecoded and aren't touched by this
  extension.

## Backup/restore scripts

The `scripts/` folder has standalone, dependency-free Python command-line
tools — `export.py` and `import.py` — for backing up all of a character's
macros as a single, human-readable `macros.yaml` file, and restoring them
into a fresh folder. These run outside VS Code and aren't part of the
extension itself. See [`scripts/README.md`](scripts/README.md) for usage and
the yaml format.

## Packaging (optional)

To install this as a normal extension instead of running it via `F5`:

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension ffxi-macro-editor-0.1.0.vsix
```
