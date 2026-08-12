#!/usr/bin/env python3
"""
Import a macros.yaml file (as produced by export.py) and (re)create the
mcr*.dat and mcr.ttl / mcr_2.ttl files it describes in an output directory.

Usage:
    python3 import.py <macros.yaml> <output_directory>

Only mcr*.dat files for book/set combinations that actually appear in the
yaml are written - this does not pre-create all 400 possible files.
mcr.ttl and mcr_2.ttl are always written (covering all 40 books, blank for
any book not present in the yaml), so book names are consistent even if only
one half of the range has data.

Values exceeding the game's field limits (15 chars for book names, 8 for
macro names, 60 for command lines) are truncated with a warning rather than
rejected outright.

Note: freshly-created files use a placeholder group id (the still-not-fully-
understood 4 bytes at header offset 4-7; see the extension's README for what
is and isn't known about that field), since a yaml-only import has no real
character's existing header to copy one from.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ffxi_format as fmt  # noqa: E402
import yaml_subset as yml  # noqa: E402


def safe_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def build_macro_list(set_entry, context):
    """set_entry is the {'ctrl': {...}, 'alt': {...}} dict for one macro set."""
    macros = fmt.blank_macro_list()

    for bar, base_index in (('ctrl', 0), ('alt', 10)):
        bar_entry = set_entry.get(bar)
        if not isinstance(bar_entry, dict):
            continue

        for slot_key, slot_entry in bar_entry.items():
            slot_number = safe_int(slot_key)
            if slot_number is None or not (1 <= slot_number <= 10):
                print(f'warning: skipping out-of-range {bar} slot "{slot_key}" in {context}', file=sys.stderr)
                continue
            if not isinstance(slot_entry, dict):
                continue

            linear_index = base_index + (slot_number - 1)

            macro_name = slot_entry.get('name', '') or ''
            if len(macro_name) > fmt.NAME_MAX_LENGTH:
                print(
                    f'warning: macro name "{macro_name}" ({context} {bar} {slot_number}) exceeds '
                    f'{fmt.NAME_MAX_LENGTH} chars, truncating',
                    file=sys.stderr
                )
                macro_name = macro_name[:fmt.NAME_MAX_LENGTH]

            lines = [''] * fmt.LINE_COUNT
            cmd = slot_entry.get('cmd')
            if isinstance(cmd, dict):
                for line_key, line_val in cmd.items():
                    line_number = safe_int(line_key)
                    if line_number is None or not (1 <= line_number <= fmt.LINE_COUNT):
                        print(
                            f'warning: skipping out-of-range command line "{line_key}" '
                            f'({context} {bar} {slot_number})',
                            file=sys.stderr
                        )
                        continue
                    text_val = '' if line_val is None else str(line_val)
                    if len(text_val) > fmt.LINE_SIZE - 1:
                        print(
                            f'warning: command line too long ({context} {bar} {slot_number} '
                            f'line {line_number}), truncating',
                            file=sys.stderr
                        )
                        text_val = text_val[:fmt.LINE_SIZE - 1]
                    lines[line_number - 1] = text_val

            macros[linear_index] = {'name': macro_name, 'lines': lines}

    return macros


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('yaml_file', help='Path to a macros.yaml file')
    parser.add_argument(
        'output_directory',
        help='Directory to write mcr*.dat / mcr.ttl / mcr_2.ttl into (created if it does not exist)'
    )
    args = parser.parse_args()

    if not os.path.isfile(args.yaml_file):
        print(f'error: no such file: {args.yaml_file}', file=sys.stderr)
        sys.exit(1)

    with open(args.yaml_file, 'r', encoding='utf-8') as f:
        text = f.read()

    data = yml.load(text)
    if data is None or not isinstance(data.get('book'), dict):
        print(
            f"error: {args.yaml_file} isn't a recognized macros.yaml file "
            "(missing top-level 'book:' block, or unsupported YAML shape)",
            file=sys.stderr
        )
        sys.exit(1)

    os.makedirs(args.output_directory, exist_ok=True)

    ttl_names = fmt.empty_ttl_names() * 2  # 40 slots: index 0 = book 1 .. index 39 = book 40
    dat_files_written = 0

    for book_key, book_entry in data['book'].items():
        book_number = safe_int(book_key)
        if book_number is None or not (1 <= book_number <= fmt.BOOKS_PER_CHARACTER):
            print(f'warning: skipping out-of-range book "{book_key}"', file=sys.stderr)
            continue
        if not isinstance(book_entry, dict):
            continue

        name = book_entry.get('name', '') or ''
        if len(name) > fmt.TTL_NAME_MAX_LENGTH:
            print(
                f'warning: book {book_number} name "{name}" exceeds {fmt.TTL_NAME_MAX_LENGTH} chars, truncating',
                file=sys.stderr
            )
            name = name[:fmt.TTL_NAME_MAX_LENGTH]
        ttl_names[book_number - 1] = name

        macro_sets = book_entry.get('macro_sets')
        if not isinstance(macro_sets, dict):
            continue

        for set_key, set_entry in macro_sets.items():
            set_number = safe_int(set_key)
            if set_number is None or not (1 <= set_number <= fmt.SETS_PER_BOOK):
                print(f'warning: skipping out-of-range set "{set_key}" in book {book_number}', file=sys.stderr)
                continue
            if not isinstance(set_entry, dict):
                continue

            context = f'book {book_number} set {set_number}'
            macros = build_macro_list(set_entry, context)

            buffer = fmt.serialize_macro_set({'version': 1, 'group_id': fmt.DEFAULT_GROUP_ID}, macros)
            filename = fmt.file_name_for_book_set(book_number, set_number)
            out_path = os.path.join(args.output_directory, filename)
            with open(out_path, 'wb') as f:
                f.write(buffer)
            dat_files_written += 1

    ttl1 = fmt.serialize_ttl({'version': 1, 'group_id': fmt.DEFAULT_GROUP_ID}, ttl_names[0:20])
    ttl2 = fmt.serialize_ttl({'version': 1, 'group_id': fmt.DEFAULT_GROUP_ID}, ttl_names[20:40])
    with open(os.path.join(args.output_directory, 'mcr.ttl'), 'wb') as f:
        f.write(ttl1)
    with open(os.path.join(args.output_directory, 'mcr_2.ttl'), 'wb') as f:
        f.write(ttl2)

    out_abs = os.path.abspath(args.output_directory)
    print(f'Wrote {dat_files_written} macro set file(s) and mcr.ttl / mcr_2.ttl to {out_abs}')


if __name__ == '__main__':
    main()
