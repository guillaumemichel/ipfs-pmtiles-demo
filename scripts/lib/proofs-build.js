// Build the proofs/ tree: pack the map's leaf digests into ≤ cap shard files
// in file order, then shape directories with a left-shallow rule — earliest
// byte ranges (the low, hot zoom levels: PMTiles orders tiles zoom-major)
// stay at the top; the long tail of deep-zoom shards nests into
// subdirectories, depth growing logarithmically toward the end of the file.
// The shape is publisher policy only: clients descend meta files by byte
// offset and never depend on it.
import { createHash } from 'node:crypto';

import {
  KIND_DIR,
  KIND_SHARD,
  SHARD_FILE_CAP,
  SHARD_RECORD_SIZE,
  shardName,
} from './proof-format.js';
import { encodeMeta, encodeShard } from './proof-encode.js';

export const SHARD_CAP_BYTES = SHARD_FILE_CAP;
const META_MAX_ENTRIES = 256;

// leaves: [{offset, length, digest(Uint8Array 32)}], contiguous from 0.
// Returns { files: [{path, content}], topMeta, shardCount } — paths relative
// to the proofs directory, including every `meta` (the top one at 'meta').
export function buildProofTree(leaves, { shardCap = SHARD_CAP_BYTES, maxEntries = META_MAX_ENTRIES } = {}) {
  if (leaves.length === 0) throw new Error('no leaves to prove');
  if (maxEntries < 2) throw new Error('maxEntries must be at least 2');
  let expected = 0;
  for (const leaf of leaves) {
    if (leaf.offset !== expected) {
      throw new Error(`leaves not contiguous: offset ${leaf.offset}, expected ${expected}`);
    }
    expected += leaf.length;
  }

  const shards = packShards(leaves, shardCap);
  const files = [];
  const top = emitDir(shards, '', files, maxEntries);
  files.push({ path: 'meta', content: top });
  return { files, topMeta: top, shardCount: shards.length };
}

// Records are a fixed 36 B, so the cap translates directly into a record
// count per shard (64 KiB -> 1,820) and every shard lands at or just under
// the cap while covering a contiguous range.
function packShards(leaves, cap) {
  const perShard = Math.floor(cap / SHARD_RECORD_SIZE);
  if (perShard < 1) {
    throw new Error(`shard cap ${cap} is below one ${SHARD_RECORD_SIZE} B record`);
  }
  const shards = [];
  for (let i = 0; i < leaves.length; i += perShard) {
    const group = leaves.slice(i, i + perShard);
    const start = group[0].offset;
    shards.push({
      start,
      length: group.reduce((n, l) => n + l.length, 0),
      content: encodeShard(group, start),
    });
  }
  return shards;
}

// ≤ maxEntries children per directory. When there are more shards, the first
// half stay files here and the rest split into equal contiguous groups, one
// subdirectory each (recursing). Emits shard/meta files into `files` and
// returns this directory's meta bytes (the parent stores its digest).
function emitDir(shards, prefix, files, maxEntries) {
  let head = shards;
  const entries = [];
  if (shards.length > maxEntries) {
    const headCount = Math.floor(maxEntries / 2);
    head = shards.slice(0, headCount);
    const rest = shards.slice(headCount);
    const groupSize = Math.ceil(rest.length / (maxEntries - headCount));
    for (let i = 0; i < rest.length; i += groupSize) {
      const group = rest.slice(i, i + groupSize);
      const dirName = shardName(group[0].start);
      const meta = emitDir(group, `${prefix}${dirName}/`, files, maxEntries);
      files.push({ path: `${prefix}${dirName}/meta`, content: meta });
      entries.push({
        kind: KIND_DIR,
        length: group.reduce((n, s) => n + s.length, 0),
        digest: sha256(meta),
      });
    }
  }
  for (const shard of head) {
    files.push({ path: `${prefix}${shardName(shard.start)}`, content: shard.content });
  }
  return encodeMeta([
    ...head.map((s) => ({ kind: KIND_SHARD, length: s.length, digest: sha256(s.content) })),
    ...entries,
  ]);
}

export function sha256(bytes) {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}
