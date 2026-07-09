// Build-side encoders for the binary proof formats. The decoders — the only
// half the browser ships — live in src/proof-format.js together with the
// format constants and record layouts these encoders must match.
import {
  DIGEST_LENGTH,
  KIND_DIR,
  KIND_SHARD,
  MAX_SHARD_RECORDS,
  META_RECORD_SIZE,
  SHARD_RECORD_SIZE,
} from '../../src/proof-format.js';

// leaves: [{offset, digest(Uint8Array 32)}] in file order, absolute offsets;
// startOffset is the shard's start (its filename).
export function encodeShard(leaves, startOffset) {
  if (leaves.length === 0) throw new Error('empty shard');
  if (leaves.length > MAX_SHARD_RECORDS) {
    throw new Error(`${leaves.length} records exceed the ${MAX_SHARD_RECORDS}-record limit`);
  }
  const out = new Uint8Array(leaves.length * SHARD_RECORD_SIZE);
  let prev = -1;
  leaves.forEach(({ offset, digest }, i) => {
    assertDigest(digest);
    const rel = offset - startOffset;
    if (!Number.isSafeInteger(rel) || rel < 0 || rel > 0xffffffff) {
      throw new Error(`relative offset ${rel} does not fit u32`);
    }
    if (i === 0 && rel !== 0) throw new Error('first record must start the shard');
    if (rel <= prev) throw new Error('offsets not strictly ascending');
    prev = rel;
    const pos = i * SHARD_RECORD_SIZE;
    out[pos] = rel & 0xff;
    out[pos + 1] = (rel >>> 8) & 0xff;
    out[pos + 2] = (rel >>> 16) & 0xff;
    out[pos + 3] = (rel >>> 24) & 0xff;
    out.set(digest, pos + 4);
  });
  return out;
}

// entries: [{kind, length, digest(Uint8Array 32)}] in file order.
export function encodeMeta(entries) {
  const out = new Uint8Array(entries.length * META_RECORD_SIZE);
  entries.forEach(({ kind, length, digest }, i) => {
    if (kind !== KIND_SHARD && kind !== KIND_DIR) throw new Error(`invalid kind ${kind}`);
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new Error(`invalid record length ${length}`);
    }
    assertDigest(digest);
    const pos = i * META_RECORD_SIZE;
    out[pos] = kind;
    writeU64LE(out, pos + 1, length);
    out.set(digest, pos + 9);
  });
  return out;
}

// records: [{path, digest(Uint8Array 32)}]; sorted here for determinism.
export function encodeFontProofs(records) {
  const encoder = new TextEncoder();
  const sorted = [...records].sort((a, b) => (a.path < b.path ? -1 : 1));
  let prev = '';
  return concatRecords(
    sorted.map(({ path, digest }) => {
      if (typeof path !== 'string' || path.length === 0) throw new Error('empty path');
      if (path <= prev) throw new Error(`duplicate path ${path}`);
      prev = path;
      assertDigest(digest);
      const pathBytes = encoder.encode(path);
      if (pathBytes.length > 0xffff) throw new Error(`path exceeds u16: ${path}`);
      return [Uint8Array.of(pathBytes.length & 0xff, pathBytes.length >>> 8), pathBytes, digest];
    }),
  );
}

function writeU64LE(out, pos, value) {
  let lo = value % 0x100000000;
  let hi = Math.floor(value / 0x100000000);
  for (let i = 0; i < 4; i++) {
    out[pos + i] = lo & 0xff;
    lo >>>= 8;
  }
  for (let i = 4; i < 8; i++) {
    out[pos + i] = hi & 0xff;
    hi >>>= 8;
  }
}

function assertDigest(digest) {
  if (!(digest instanceof Uint8Array) || digest.length !== DIGEST_LENGTH) {
    throw new Error('digest must be 32 bytes');
  }
}

function concatRecords(records) {
  const parts = records.flat();
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
