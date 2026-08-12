#!/usr/bin/env python3
"""
Export FFXI macro data (mcr*.dat + mcr.ttl / mcr_2.ttl) from a character
folder into a single, human-readable macros.yaml file.

Usage:
    python3 export.py [directory]

DIRECTORY is used both as the source (where mcr*.dat / mcr.ttl / mcr_2.ttl
are read from) and the destination (where macros.yaml is written). If
omitted, the current working directory is used.

Only books with a name and/or macro content are written, and only sets /
macro slots / command lines that actually have content - the output is a
sparse summary, not a dump of all 40 books x 10 sets x 20 slots x 6 lines.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ffxi_format as fmt  # noqa: E402
import yaml_subset as yml  # noqa: E402


def load_all_book_names(directory):
    """Read mcr.ttl (books 1-20) and mcr_2.ttl (books 21-40); missing/unreadable halves are left blank."""
    names = [''] * fmt.BOOKS_PER_CHARACTER
    for filename, offset in (('mcr.ttl', 0), ('mcr_2.ttl', 20)):
        path = os.path.join(directory, filename)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, 'rb') as f:
                buf = f.read()
            parsed = fmt.parse_ttl(buf)
        except (OSError, ValueError) as exc:
            print(f'warning: could not read {filename}: {exc}', file=sys.stderr)
            continue
        for i, name in enumerate(parsed['names']):
            names[offset + i] = name
    return names


def load_all_macro_sets(directory):
    """Scan the directory for mcr*.dat files and parse each one found.
    Returns {(book_number, set_number): parsed_macro_set}."""
    present = {}
    try:
        entries = os.listdir(directory)
    except OSError as exc:
        print(f'error: could not list {directory}: {exc}', file=sys.stderr)
        sys.exit(1)

    for filename in entries:
        location = fmt.book_set_for_file_name(filename)
        if location is None:
            continue
        book_number, set_number, _ = location
        path = os.path.join(directory, filename)
        try:
            with open(path, 'rb') as f:
                buf = f.read()
            parsed = fmt.parse_macro_set(buf)
        except (OSError, ValueError) as exc:
            print(f'warning: skipping {filename}: {exc}', file=sys.stderr)
            continue
        present[(book_number, set_number)] = parsed
    return present


def macro_slot_to_dict(macro):
    """Convert one parsed macro slot to the sparse {name?, cmd?} yaml shape, or None if it's entirely empty."""
    name = macro.get('name', '')
    lines = macro.get('lines', [])
    non_empty_lines = {str(i + 1): line for i, line in enumerate(lines) if line}
    if not name and not non_empty_lines:
        return None
    entry = {}
    if name:
        entry['name'] = name
    if non_empty_lines:
        entry['cmd'] = non_empty_lines
    return entry


def gather(directory):
    names = load_all_book_names(directory)
    present = load_all_macro_sets(directory)

    books_out = {}
    for book_number in range(1, fmt.BOOKS_PER_CHARACTER + 1):
        book_name = names[book_number - 1]

        macro_sets_out = {}
        for set_number in range(1, fmt.SETS_PER_BOOK + 1):
            parsed = present.get((book_number, set_number))
            if parsed is None:
                continue

            ctrl_out = {}
            alt_out = {}
            for i in range(1, 11):
                ctrl_slot = macro_slot_to_dict(parsed['macros'][i - 1])
                if ctrl_slot is not None:
                    ctrl_out[str(i)] = ctrl_slot
                alt_slot = macro_slot_to_dict(parsed['macros'][10 + i - 1])
                if alt_slot is not None:
                    alt_out[str(i)] = alt_slot

            if ctrl_out or alt_out:
                set_entry = {}
                if ctrl_out:
                    set_entry['ctrl'] = ctrl_out
                if alt_out:
                    set_entry['alt'] = alt_out
                macro_sets_out[str(set_number)] = set_entry

        if book_name or macro_sets_out:
            book_entry = {}
            if book_name:
                book_entry['name'] = book_name
            if macro_sets_out:
                book_entry['macro_sets'] = macro_sets_out
            books_out[str(book_number)] = book_entry

    return {'book': books_out}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        'directory', nargs='?', default=os.getcwd(),
        help='Character folder to read mcr*.dat / mcr.ttl / mcr_2.ttl from, and write macros.yaml into '
             '(default: current directory)'
    )
    args = parser.parse_args()

    directory = os.path.abspath(args.directory)
    if not os.path.isdir(directory):
        print(f'error: not a directory: {directory}', file=sys.stderr)
        sys.exit(1)

    data = gather(directory)
    text = yml.dump(data)

    out_path = os.path.join(directory, 'macros.yaml')
    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)

    book_count = len(data['book'])
    set_count = sum(len(b.get('macro_sets', {})) for b in data['book'].values())
    print(f'Exported {book_count} book(s), {set_count} macro set(s) to {out_path}')


if __name__ == '__main__':
    main()
