"""
A minimal, dependency-free YAML subset reader/writer shared by export.py and
import.py, so neither script needs `pip install pyyaml` to run.

Supports nested "key: value" scalars and "key:" block headers at any depth.
No lists, no multi-line strings, no anchors. Values may be double- or
single-quoted (double-quoted values use standard JSON string escaping).

Indentation handling is deliberately lenient: each block's own child
indentation is established independently by that block's *first* child line,
rather than requiring a single fixed step (e.g. always exactly 2 spaces)
across the whole file. Siblings within one block must still match each
other's indent exactly, but two unrelated blocks elsewhere in the file are
free to use different indent widths from each other. This matters in
practice - hand-typed YAML is rarely perfectly consistent line to line, and
the reference macros.yaml this format is modeled on itself has exactly this
kind of variance between two sibling blocks.

Anything outside this supported subset causes load() to return None rather
than guess wrong, so callers can choose not to overwrite a file they can't
confidently understand.
"""

import json
import re

_KV_RE = re.compile(r'^([^:\s][^:]*):\s?(.*)$')
_INDENT_RE = re.compile(r'^( *)(.*)$')
_LEADING_SPECIAL = set('"\'>|*&!%#,[]{}')


def encode_scalar(value):
    """Encode a single scalar value as a YAML value, quoting only when necessary."""
    text = '' if value is None else str(value)
    needs_quoting = (
        text == '' or
        text != text.strip() or
        (len(text) > 0 and text[0] in _LEADING_SPECIAL) or
        bool(re.search(r':(\s|$)', text)) or
        ('#' in text) or
        ('\n' in text)
    )
    return json.dumps(text) if needs_quoting else text


def decode_scalar(raw):
    """Decode a single YAML scalar value (the part after 'key: ')."""
    trimmed = raw.strip()
    if trimmed == '':
        return ''
    if trimmed[0] == '"':
        try:
            return json.loads(trimmed)
        except ValueError:
            return trimmed
    if len(trimmed) >= 2 and trimmed[0] == "'" and trimmed[-1] == "'":
        return trimmed[1:-1].replace("''", "'")
    return trimmed


def _write_lines(obj, depth, lines):
    pad = '  ' * depth
    for key, value in obj.items():
        if isinstance(value, dict):
            lines.append(f'{pad}{key}:')
            _write_lines(value, depth + 1, lines)
        else:
            lines.append(f'{pad}{key}: {encode_scalar(value)}')


def dump(obj):
    """Serialize a plain dict (arbitrary depth, scalar leaves) to YAML text.
    Always uses a consistent 2-space step per level, regardless of how
    lenient load() is on the way in - machine output should be canonical."""
    lines = []
    _write_lines(obj or {}, 0, lines)
    return '\n'.join(lines) + '\n'


def load(text):
    """Parse YAML text (our supported subset only). Returns None if it isn't
    in that subset, rather than guessing or raising."""
    if not isinstance(text, str):
        return None

    root = {}
    # Each frame: opening_indent (indent of the "key:" line that opened this
    # block; -1 for the implicit root), children_indent (indent established
    # by this block's first child line, or None until seen), and obj (the
    # dict this frame is populating).
    stack = [{'opening_indent': -1, 'children_indent': None, 'obj': root}]

    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if stripped == '' or stripped.startswith('#'):
            continue

        m = _INDENT_RE.match(raw_line)
        indent = len(m.group(1))
        content = m.group(2)

        kv = _KV_RE.match(content)
        if not kv:
            return None
        key = kv.group(1).strip()
        rest = kv.group(2)

        while True:
            top = stack[-1]
            if top['children_indent'] is None:
                if indent > top['opening_indent']:
                    top['children_indent'] = indent
                    break
                if len(stack) > 1:
                    stack.pop()
                    continue
                return None  # unreachable: root's opening_indent is -1
            if indent == top['children_indent']:
                break
            if indent > top['children_indent']:
                return None  # deeper than this block's established child indent, with no block header in between
            if len(stack) > 1:
                stack.pop()
                continue
            return None

        parent = stack[-1]
        if rest == '':
            child = {}
            parent['obj'][key] = child
            stack.append({'opening_indent': indent, 'children_indent': None, 'obj': child})
        else:
            parent['obj'][key] = decode_scalar(rest)

    return root
