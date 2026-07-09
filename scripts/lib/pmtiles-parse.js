// Parse a PMTiles v3 archive: header, root directory, unique tile ranges.
import { gunzipSync } from 'node:zlib';
import { bytesToHeader, readVarint } from 'pmtiles';

export const HEADER_SIZE = 127;

const COMPRESSION_NONE = 1;
const COMPRESSION_GZIP = 2;

export function parseHeader(bytes) {
  if (bytes.length < HEADER_SIZE) {
    throw new Error(`file too short for PMTiles header: ${bytes.length} bytes`);
  }
  const copy = new Uint8Array(bytes.subarray(0, HEADER_SIZE));
  return bytesToHeader(copy.buffer);
}

function decompressDirectory(bytes, compression) {
  if (compression === COMPRESSION_NONE) return bytes;
  if (compression === COMPRESSION_GZIP) return gunzipSync(bytes);
  throw new Error(`unsupported internal compression: ${compression}`);
}

// Directory entries: varint count, then delta-encoded tileIds, runLengths,
// lengths, and offsets (0 means "previous offset + previous length").
export function parseDirectory(bytes, compression) {
  const buf = decompressDirectory(bytes, compression);
  const state = { buf, pos: 0 };
  const numEntries = readVarint(state);

  const entries = [];
  let tileId = 0;
  for (let i = 0; i < numEntries; i++) {
    tileId += readVarint(state);
    entries.push({ tileId, runLength: 0, length: 0, offset: 0 });
  }
  for (const e of entries) e.runLength = readVarint(state);
  for (const e of entries) e.length = readVarint(state);
  for (let i = 0; i < numEntries; i++) {
    const v = readVarint(state);
    if (v === 0) {
      if (i === 0) throw new Error('first directory entry has no offset');
      entries[i].offset = entries[i - 1].offset + entries[i - 1].length;
    } else {
      entries[i].offset = v - 1;
    }
  }
  return entries;
}

// Unique (offset, length) tile ranges relative to the tile-data section,
// sorted by offset, deduplicated.
export function uniqueTileRanges(entries) {
  const byOffset = new Map();
  for (const e of entries) {
    if (e.runLength === 0) continue; // leaf directory pointer, not tile data
    const existing = byOffset.get(e.offset);
    if (existing !== undefined && existing !== e.length) {
      throw new Error(`conflicting lengths for tile offset ${e.offset}`);
    }
    byOffset.set(e.offset, e.length);
  }
  return [...byOffset.entries()]
    .map(([offset, length]) => ({ offset, length }))
    .sort((a, b) => a.offset - b.offset);
}

export function parseArchive(fileBytes) {
  const header = parseHeader(fileBytes);
  if (header.leafDirectoryLength > 0) {
    throw new Error('archive has leaf directories; expected root-only');
  }
  const rootDirBytes = fileBytes.subarray(
    header.rootDirectoryOffset,
    header.rootDirectoryOffset + header.rootDirectoryLength,
  );
  const entries = parseDirectory(rootDirBytes, header.internalCompression);
  return { header, entries, tileRanges: uniqueTileRanges(entries) };
}
