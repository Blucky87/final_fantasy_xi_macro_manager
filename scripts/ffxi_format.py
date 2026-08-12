"""
Pure Python re-implementation of the mcr*.dat / mcr.ttl / mcr_2.ttl binary
format used by the FFXI Macro Editor VS Code extension. Mirrors
../macroFormat.js, ../ttlFormat.js, and ../binUtils.js - see those for the
canonical (and more thoroughly commented) version of this logic.

No file I/O in this module on purpose - export.py and import.py own that, so
this module stays trivially testable in isolation.
"""

import hashlib
import re

HEADER_SIZE = 24
ENTRY_SIZE = 380
NUM_ENTRIES = 20
LINE_OFF = 4
LINE_SIZE = 61
LINE_COUNT = 6
NAME_OFF = 370
NAME_SIZE = 10
FILE_SIZE = HEADER_SIZE + NUM_ENTRIES * ENTRY_SIZE  # 7624
NAME_MAX_LENGTH = 8  # in-game display limit (the field itself has 9 bytes of usable capacity, but 8 is what actually shows/works)

TTL_HEADER_SIZE = 24
TTL_RECORD_SIZE = 16
TTL_RECORDS_PER_FILE = 20
TTL_FILE_SIZE = TTL_HEADER_SIZE + TTL_RECORDS_PER_FILE * TTL_RECORD_SIZE  # 344
TTL_NAME_MAX_LENGTH = TTL_RECORD_SIZE - 1  # 15

BOOKS_PER_CHARACTER = 40
SETS_PER_BOOK = 10

DEFAULT_GROUP_ID = '00000000'

_MCR_FILENAME_RE = re.compile(r'^mcr(\d*)\.dat$', re.IGNORECASE)


def read_cstring(buf, start, length):
    chunk = bytes(buf[start:start + length])
    idx = chunk.find(b'\x00')
    raw = chunk if idx == -1 else chunk[:idx]
    return raw.decode('latin1')


def write_cstring(buf, start, length, value, max_chars=None):
    """Write a string into a fixed-size field, zero-padded, null-terminated
    only if it fits within max_chars (defaults to length-1, i.e. always
    reserving room for a terminator)."""
    cap = (length - 1) if max_chars is None else max_chars
    text = (value or '')[:cap]
    encoded = text.encode('latin1', errors='replace')
    buf[start:start + length] = b'\x00' * length
    buf[start:start + len(encoded)] = encoded


def _checksum(buf, header_size):
    return hashlib.md5(bytes(buf[header_size:])).digest()


def parse_macro_set(buffer):
    if len(buffer) != FILE_SIZE:
        raise ValueError(f'Unexpected file size: {len(buffer)} bytes (expected {FILE_SIZE})')

    version = int.from_bytes(buffer[0:4], 'little')
    group_id = buffer[4:8].hex()
    stored_checksum = buffer[8:HEADER_SIZE].hex()
    computed_checksum = _checksum(buffer, HEADER_SIZE).hex()

    macros = []
    for i in range(NUM_ENTRIES):
        base = HEADER_SIZE + i * ENTRY_SIZE
        entry = buffer[base:base + ENTRY_SIZE]
        name = read_cstring(entry, NAME_OFF, NAME_SIZE)
        lines = [read_cstring(entry, LINE_OFF + l * LINE_SIZE, LINE_SIZE) for l in range(LINE_COUNT)]
        macros.append({'name': name, 'lines': lines})

    return {
        'version': version,
        'group_id': group_id,
        'stored_checksum': stored_checksum,
        'computed_checksum': computed_checksum,
        'checksum_valid': stored_checksum == computed_checksum,
        'macros': macros,
    }


def blank_macro_list():
    return [{'name': '', 'lines': [''] * LINE_COUNT} for _ in range(NUM_ENTRIES)]


def serialize_macro_set(meta, macros):
    buf = bytearray(FILE_SIZE)
    buf[0:4] = int(meta.get('version', 1)).to_bytes(4, 'little')
    buf[4:8] = bytes.fromhex(meta.get('group_id') or DEFAULT_GROUP_ID)

    for i in range(NUM_ENTRIES):
        base = HEADER_SIZE + i * ENTRY_SIZE
        macro = macros[i] if i < len(macros) else {}
        lines = macro.get('lines') or ([''] * LINE_COUNT)
        for l in range(LINE_COUNT):
            line_val = lines[l] if l < len(lines) else ''
            write_cstring(buf, base + LINE_OFF + l * LINE_SIZE, LINE_SIZE, line_val)
        write_cstring(buf, base + NAME_OFF, NAME_SIZE, macro.get('name', ''))

    checksum = _checksum(buf, HEADER_SIZE)
    buf[8:HEADER_SIZE] = checksum
    return bytes(buf)


def parse_ttl(buffer):
    if len(buffer) != TTL_FILE_SIZE:
        raise ValueError(f'Unexpected .ttl file size: {len(buffer)} bytes (expected {TTL_FILE_SIZE})')

    version = int.from_bytes(buffer[0:4], 'little')
    group_id = buffer[4:8].hex()
    stored_checksum = buffer[8:TTL_HEADER_SIZE].hex()
    computed_checksum = _checksum(buffer, TTL_HEADER_SIZE).hex()

    names = [read_cstring(buffer, TTL_HEADER_SIZE + i * TTL_RECORD_SIZE, TTL_RECORD_SIZE)
             for i in range(TTL_RECORDS_PER_FILE)]

    return {
        'version': version,
        'group_id': group_id,
        'stored_checksum': stored_checksum,
        'computed_checksum': computed_checksum,
        'checksum_valid': stored_checksum == computed_checksum,
        'names': names,
    }


def empty_ttl_names():
    return [''] * TTL_RECORDS_PER_FILE


def serialize_ttl(meta, names):
    buf = bytearray(TTL_FILE_SIZE)
    buf[0:4] = int(meta.get('version', 1)).to_bytes(4, 'little')
    buf[4:8] = bytes.fromhex(meta.get('group_id') or DEFAULT_GROUP_ID)

    for i in range(TTL_RECORDS_PER_FILE):
        base = TTL_HEADER_SIZE + i * TTL_RECORD_SIZE
        value = names[i] if i < len(names) else ''
        write_cstring(buf, base, TTL_RECORD_SIZE, value)

    checksum = _checksum(buf, TTL_HEADER_SIZE)
    buf[8:TTL_HEADER_SIZE] = checksum
    return bytes(buf)


def file_name_for_book_set(book_number, set_number):
    if not (1 <= book_number <= BOOKS_PER_CHARACTER):
        raise ValueError(f'Book number out of range: {book_number}')
    if not (1 <= set_number <= SETS_PER_BOOK):
        raise ValueError(f'Set number out of range: {set_number}')
    idx = (book_number - 1) * SETS_PER_BOOK + (set_number - 1)
    return 'mcr.dat' if idx == 0 else f'mcr{idx}.dat'


def book_set_for_file_name(filename):
    """'mcr.dat' / 'mcr17.dat' -> (book_number, set_number, file_index), or None if it doesn't match."""
    m = _MCR_FILENAME_RE.match(filename)
    if not m:
        return None
    idx = 0 if m.group(1) == '' else int(m.group(1))
    book_number = idx // SETS_PER_BOOK + 1
    set_number = idx % SETS_PER_BOOK + 1
    return (book_number, set_number, idx)


def ttl_location_for_book(book_number):
    if not (1 <= book_number <= BOOKS_PER_CHARACTER):
        raise ValueError(f'Book number out of range: {book_number}')
    filename = 'mcr.ttl' if book_number <= 20 else 'mcr_2.ttl'
    record_index = (book_number - 1) % TTL_RECORDS_PER_FILE
    return (filename, record_index)
