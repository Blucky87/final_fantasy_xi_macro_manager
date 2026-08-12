// Parser/serializer for FFXI "mcr*.dat" macro set files, and the
// book/set <-> filename numbering scheme that ties them to mcr.ttl / mcr_2.ttl.
//
// Layout (per README.md reverse-engineering notes):
//   Header (24 bytes)
//     0-3    version        u32 LE, always 1
//     4-7    group id       4 bytes, shared per character
//     8-23   checksum       16 bytes, MD5 of the 7600 bytes that follow (assumed)
//   20 x Entry (380 bytes each), back to back, starting at byte 24
//     0-3    reserved       4 bytes, always 0
//     4-64   command line 1 61 bytes, null-terminated
//     ...    command line 2-6, same size
//     370-379 macro name    10 bytes, null-terminated
//
// Entries 0-9 are Ctrl+1..Ctrl+0, entries 10-19 are Alt+1..Alt+0.
//
// File numbering: a character has 40 books x 10 sets = 400 possible files.
// fileIndex = (bookNumber-1)*10 + (setNumber-1), 0-based, 0..399.
// fileIndex 0 is named "mcr.dat" (no digits); all others are "mcr{fileIndex}.dat".

'use strict';

const crypto = require('crypto');
const { readCString, writeCString } = require('./binUtils');

const HEADER_SIZE = 24;
const ENTRY_SIZE = 380;
const NUM_ENTRIES = 20;
const LINE_OFF = 4;
const LINE_SIZE = 61;
const LINE_COUNT = 6;
const NAME_OFF = 370;
const NAME_SIZE = 10;
const FILE_SIZE = HEADER_SIZE + NUM_ENTRIES * ENTRY_SIZE; // 7624

const BOOKS_PER_CHARACTER = 40;
const SETS_PER_BOOK = 10;

const SLOT_LABELS = [];
for (let i = 0; i < 10; i++) SLOT_LABELS.push(`Ctrl+${(i + 1) % 10}`);
for (let i = 0; i < 10; i++) SLOT_LABELS.push(`Alt+${(i + 1) % 10}`);

function pad2(n) {
  return String(n).padStart(2, '0');
}

function computeChecksum(buffer) {
  const entriesData = buffer.subarray(HEADER_SIZE);
  return crypto.createHash('md5').update(entriesData).digest();
}

/**
 * Parse a raw mcr*.dat buffer into a plain-object representation.
 * Throws if the buffer isn't the expected fixed size.
 */
function parseMacroSet(buffer) {
  if (buffer.length !== FILE_SIZE) {
    throw new Error(
      `Unexpected file size: ${buffer.length} bytes (expected ${FILE_SIZE}). ` +
      `This does not look like a standard mcr*.dat macro set file.`
    );
  }

  const version = buffer.readUInt32LE(0);
  const groupId = buffer.subarray(4, 8).toString('hex');
  const storedChecksum = buffer.subarray(8, HEADER_SIZE).toString('hex');
  const computedChecksum = computeChecksum(buffer).toString('hex');

  const macros = [];
  for (let i = 0; i < NUM_ENTRIES; i++) {
    const base = HEADER_SIZE + i * ENTRY_SIZE;
    const entry = buffer.subarray(base, base + ENTRY_SIZE);
    const name = readCString(entry, NAME_OFF, NAME_SIZE);
    const lines = [];
    for (let l = 0; l < LINE_COUNT; l++) {
      lines.push(readCString(entry, LINE_OFF + l * LINE_SIZE, LINE_SIZE));
    }
    macros.push({ slot: SLOT_LABELS[i], name, lines });
  }

  return {
    version,
    groupId,
    storedChecksum,
    computedChecksum,
    checksumValid: storedChecksum === computedChecksum,
    macros
  };
}

/**
 * Serialize macros back into a full mcr*.dat buffer, re-using the original
 * version/group id, and recomputing the MD5 checksum over the new entry data.
 */
function serializeMacroSet(meta, macros) {
  const buffer = Buffer.alloc(FILE_SIZE); // zero-filled, handles reserved/padding bytes
  buffer.writeUInt32LE(meta.version || 1, 0);
  Buffer.from(meta.groupId || '00000000', 'hex').copy(buffer, 4);
  // bytes 8-23 (checksum) are filled in below, after entries are written

  for (let i = 0; i < NUM_ENTRIES; i++) {
    const base = HEADER_SIZE + i * ENTRY_SIZE;
    const macro = macros[i] || { name: '', lines: [] };
    for (let l = 0; l < LINE_COUNT; l++) {
      writeCString(buffer, base + LINE_OFF + l * LINE_SIZE, LINE_SIZE, macro.lines[l]);
    }
    writeCString(buffer, base + NAME_OFF, NAME_SIZE, macro.name);
  }

  const checksum = computeChecksum(buffer);
  checksum.copy(buffer, 8);

  return buffer;
}

/** Build a blank in-memory macro set (used when opening a set that has no file on disk yet). */
function blankMacroSet(groupId) {
  return {
    version: 1,
    groupId: groupId || '00000000',
    storedChecksum: null,
    computedChecksum: null,
    checksumValid: null,
    macros: SLOT_LABELS.map((slot) => ({ slot, name: '', lines: new Array(LINE_COUNT).fill('') }))
  };
}

/** 1-based bookNumber (1-40) + setNumber (1-10) -> "mcr.dat" / "mcrN.dat" */
function fileNameForBookSet(bookNumber, setNumber) {
  if (bookNumber < 1 || bookNumber > BOOKS_PER_CHARACTER) {
    throw new Error(`Book number out of range: ${bookNumber}`);
  }
  if (setNumber < 1 || setNumber > SETS_PER_BOOK) {
    throw new Error(`Set number out of range: ${setNumber}`);
  }
  const idx = (bookNumber - 1) * SETS_PER_BOOK + (setNumber - 1);
  return idx === 0 ? 'mcr.dat' : `mcr${idx}.dat`;
}

/** "mcr.dat" / "mcr17.dat" -> {bookNumber, setNumber, fileIndex}, or null if it doesn't match. */
function bookSetForFileName(fileName) {
  const match = /^mcr(\d*)\.dat$/i.exec(fileName);
  if (!match) {
    return null;
  }
  const idx = match[1] === '' ? 0 : parseInt(match[1], 10);
  return {
    bookNumber: Math.floor(idx / SETS_PER_BOOK) + 1,
    setNumber: (idx % SETS_PER_BOOK) + 1,
    fileIndex: idx
  };
}

module.exports = {
  FILE_SIZE,
  NUM_ENTRIES,
  LINE_COUNT,
  LINE_SIZE,
  NAME_SIZE,
  SLOT_LABELS,
  BOOKS_PER_CHARACTER,
  SETS_PER_BOOK,
  pad2,
  parseMacroSet,
  serializeMacroSet,
  blankMacroSet,
  fileNameForBookSet,
  bookSetForFileName
};
