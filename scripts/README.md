# Backup/restore scripts

Standalone command-line tools for backing up and restoring FFXI macro data
as a single, human-readable `macros.yaml` file. These are plain Python 3
scripts with **no dependencies** (no `pip install` needed) — they don't run
inside VS Code and aren't part of the extension itself, just companions to
it that live in the same repo.

## `export.py` — character folder → macros.yaml

```bash
python3 export.py [directory]
```

Reads `mcr*.dat`, `mcr.ttl`, and `mcr_2.ttl` from `directory` (default: the
current directory) and writes `directory/macros.yaml` — a sparse summary
containing only books with a name and/or macro content, only sets with at
least one non-empty macro slot, and only command lines that actually have
text in them.

## `import.py` — macros.yaml → character folder

```bash
python3 import.py <macros.yaml> <output_directory>
```

Reads a `macros.yaml` file and writes the `mcr*.dat` / `mcr.ttl` /
`mcr_2.ttl` files it describes into `output_directory` (created if it
doesn't exist). Only `.dat` files for book/set combinations that actually
appear in the yaml are written; `mcr.ttl` and `mcr_2.ttl` are always written
in full (blank for any book not mentioned).

Values exceeding the game's known field limits are truncated with a warning
rather than rejected: 15 characters for book names, 8 for macro names, 60
per command line.

## `macros.yaml` format

```yaml
book:
  1:
    name: testbook
    macro_sets:
      1:
        ctrl:
          1:
            name: test
            cmd:
              1: /echo test
              3: /echo line 3
              4: /ma "Cure" <t>
        alt:
          1:
            name: test
            cmd:
              1: test
      2:
        ctrl:
          1:
            name: test
            cmd:
              1: test
```

- `book` → keyed by book number (1–40).
- `name` → the book's name (matches `mcr.ttl`/`mcr_2.ttl`, max 15 chars).
- `macro_sets` → keyed by set number (1–10).
- `ctrl` / `alt` → keyed by macro slot number (1–10, where "10" is the
  in-game `0` key — Ctrl+1..Ctrl+0 or Alt+1..Alt+0).
- `name` (under a macro slot) → the macro's own name (max 8 chars).
- `cmd` → keyed by command line number (1–6). Only non-empty lines are
  present, so gaps in the numbering (e.g. `1`, `3`, `4` with no `2`) mean
  line 2 is blank — that's intentional and preserved on import.

Book/set/slot/line numbers are plain, unpadded numbers — not zero-padded
strings like `"01"`.

### YAML support

Both scripts share a small, dependency-free YAML-subset engine
(`yaml_subset.py`) rather than requiring PyYAML. It supports nested
`key: value` scalars and `key:` block headers at any depth — no lists, no
multi-line strings, no anchors. Quote a value (standard JSON-style
double-quote escaping) if it contains a colon, a `#`, or leading/trailing
whitespace, e.g. `cmd: {1: "Provoke: reset hate"}`.

Unlike the VS Code extension's own `.ffxi.meta` parser, this engine doesn't
require a single fixed indent step across the whole file — each block's
child indentation is established independently by that block's first child
line. This is intentionally more forgiving of the kind of small
inconsistencies that show up in hand-typed YAML (e.g. one nested block using
2 extra spaces of indent relative to a sibling block elsewhere in the file);
siblings within one block still have to match each other exactly. If a file
falls outside what's supported, both scripts fail with a clear error rather
than guessing.

## Format assumptions

Written `.dat`/`.ttl` files use the same MD5-checksum assumption, header
layout, and character limits as the VS Code extension itself — see the main
[README.md](../README.md) for the reverse-engineering notes and known
uncertainties (particularly around the still-not-fully-understood 4-byte
"group id" header field, which freshly-imported files fill with a
placeholder since there's no existing character data to copy a real one
from).
