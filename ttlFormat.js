// Parser/serializer for FFXI "mcr.ttl" / "mcr_2.ttl" macro book name files.
//
// Layout (same header shape as mcr*.dat, per README.md reverse-engineering notes):
//   Header (24 bytes)
//     0-3    version    u32 LE, always 1
//     4-7    group id   4 bytes, shared per character (matches mcr*.dat)
//     8-23   checksum   16 bytes, MD5 of the 320 bytes that follow (assumed)
//   20 x record (16 bytes each): null-terminated, zero-padded book name
//
// mcr.ttl covers books 1-20 (record index 0-19).
// mcr_2.ttl covers books 21-40 (record index 0-19, representing global book-21..40).
//
// Field width: each name record is 16 bytes, null-terminated - max usable
// length is 15 characters (15 chars + 1 null byte).

'use strict';

const crypto = require('crypto');
const { readCString, writeCString } = require('./binUtils');

const HEADER_SIZE = 24;
const RECORD_SIZE = 16;
const RECORDS_PER_FILE = 20;
const FILE_SIZE = HEADER_SIZE + RECORDS_PER_FILE * RECORD_SIZE; // 344
const NAME_MAX_LENGTH = RECORD_SIZE - 1; // 15 usable chars, 1 reserved for the null terminator

function computeChecksum(buffer) {
  const recordsData = buffer.subarray(HEADER_SIZE);
  return crypto.createHash('md5').update(recordsData).digest();
}

/** 1-based global book number (1-40) -> which .ttl file it lives in, and at what record index. */
function ttlLocationForBook(bookNumber) {
  if (bookNumber < 1 || bookNumber > 40) {
    throw new Error(`Book number out of range: ${bookNumber}`);
  }
  const fileName = bookNumber <= 20 ? 'mcr.ttl' : 'mcr_2.ttl';
  const recordIndex = (bookNumber - 1) % RECORDS_PER_FILE;
  return { fileName, recordIndex };
}

function parseTtlBuffer(buffer) {
  if (buffer.length !== FILE_SIZE) {
    throw new Error(
      `Unexpected .ttl file size: ${buffer.length} bytes (expected ${FILE_SIZE}).`
    );
  }

  const version = buffer.readUInt32LE(0);
  const groupId = buffer.subarray(4, 8).toString('hex');
  const storedChecksum = buffer.subarray(8, HEADER_SIZE).toString('hex');
  const computedChecksum = computeChecksum(buffer).toString('hex');

  const names = [];
  for (let i = 0; i < RECORDS_PER_FILE; i++) {
    const base = HEADER_SIZE + i * RECORD_SIZE;
    names.push(readCString(buffer, base, RECORD_SIZE));
  }

  return {
    version,
    groupId,
    storedChecksum,
    computedChecksum,
    checksumValid: storedChecksum === computedChecksum,
    names
  };
}

function serializeTtlBuffer(meta, names) {
  const buffer = Buffer.alloc(FILE_SIZE);
  buffer.writeUInt32LE(meta.version || 1, 0);
  Buffer.from(meta.groupId || '00000000', 'hex').copy(buffer, 4);
  // bytes 8-23 (checksum) filled in below

  for (let i = 0; i < RECORDS_PER_FILE; i++) {
    const base = HEADER_SIZE + i * RECORD_SIZE;
    writeCString(buffer, base, RECORD_SIZE, names[i]); // reserves room for a null terminator: 15 usable chars
  }

  const checksum = computeChecksum(buffer);
  checksum.copy(buffer, 8);
  return buffer;
}

function emptyNames() {
  return new Array(RECORDS_PER_FILE).fill('');
}

module.exports = {
  FILE_SIZE,
  RECORDS_PER_FILE,
  NAME_MAX_LENGTH,
  ttlLocationForBook,
  parseTtlBuffer,
  serializeTtlBuffer,
  emptyNames
};
