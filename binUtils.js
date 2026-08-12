'use strict';

/** Read a null-terminated, zero-padded string out of a buffer slice. */
function readCString(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const zeroIdx = slice.indexOf(0);
  const raw = zeroIdx === -1 ? slice : slice.subarray(0, zeroIdx);
  return raw.toString('latin1');
}

/** Write a string into a fixed-size field, zero-padded, and null-terminated
 * only if it fits within maxChars (defaults to len-1, i.e. always reserving
 * room for a terminator). Pass maxChars === len explicitly for fields that
 * are allowed to fill their entire width with no trailing null. */
function writeCString(buf, start, len, str, maxChars) {
  buf.fill(0, start, start + len);
  const cap = typeof maxChars === 'number' ? maxChars : len - 1;
  const truncated = String(str || '').slice(0, cap);
  buf.write(truncated, start, 'latin1');
}

module.exports = { readCString, writeCString };
