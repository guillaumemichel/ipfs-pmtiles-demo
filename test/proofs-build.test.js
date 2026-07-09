import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeMeta,
  KIND_DIR,
  KIND_SHARD,
  shardLeavesFor,
  shardName,
  validateShard,
} from '../src/proof-format.js';
import { toHex } from '../src/verify.js';
import { buildProofTree, sha256 } from '../scripts/lib/proofs-build.js';
import { deterministicBytes } from './helpers.js';

// Synthetic contiguous leaves with deterministic digests.
function makeLeaves(lengths) {
  let offset = 0;
  return lengths.map((length, i) => {
    const leaf = { offset, length, digest: deterministicBytes(32, i + 1) };
    offset += length;
    return leaf;
  });
}

const fileMap = (files) => new Map(files.map((f) => [f.path, f.content]));

// Walk the emitted tree exactly like a client would: verify every child
// digest against its parent meta, decode, and collect all leaves.
function collectLeaves(files, topMeta, dirPrefix, dirStart, dirLength) {
  const { entries, covered } = decodeMeta(topMeta, dirStart);
  assert.equal(covered, dirLength, 'meta covers its range');
  const out = [];
  for (const entry of entries) {
    const name = shardName(entry.start);
    if (entry.kind === KIND_DIR) {
      const meta = files.get(`${dirPrefix}${name}/meta`);
      assert.ok(meta, `missing ${dirPrefix}${name}/meta`);
      assert.equal(toHex(sha256(meta)), entry.digest, 'dir digest matches child meta');
      out.push(...collectLeaves(files, meta, `${dirPrefix}${name}/`, entry.start, entry.length));
    } else {
      const shard = files.get(`${dirPrefix}${name}`);
      assert.ok(shard, `missing shard ${dirPrefix}${name}`);
      assert.equal(toHex(sha256(shard)), entry.digest, 'shard digest matches file');
      validateShard(shard, entry.length, name);
      out.push(...shardLeavesFor(shard, entry.start, entry.length));
    }
  }
  return out;
}

test('flat tree: every leaf recoverable, shards under the cap', () => {
  const leaves = makeLeaves([100, 5000, 300, 45000, 95, 7]);
  const { files, topMeta, shardCount } = buildProofTree(leaves, { shardCap: 120 });
  for (const f of files) assert.ok(f.content.length <= 120, `${f.path} over cap`);
  assert.ok(shardCount > 1);

  const total = leaves.reduce((n, l) => n + l.length, 0);
  const recovered = collectLeaves(fileMap(files), topMeta, '', 0, total);
  assert.deepEqual(
    recovered,
    leaves.map((l) => ({ offset: l.offset, length: l.length, digest: toHex(l.digest) })),
  );
});

test('nesting engages beyond maxEntries with the left-shallow shape', () => {
  const leaves = makeLeaves(Array.from({ length: 40 }, (_, i) => 10 + i));
  // One record ≈ 33 B → cap 40 gives one leaf per shard → 40 shards, F=4.
  const { files, topMeta } = buildProofTree(leaves, { shardCap: 40, maxEntries: 4 });

  const top = decodeMeta(topMeta, 0).entries;
  assert.ok(top.length <= 4);
  assert.equal(top[0].kind, KIND_SHARD, 'earliest range stays a file at the top');
  assert.equal(top.at(-1).kind, KIND_DIR, 'tail nests into subdirectories');

  const total = leaves.reduce((n, l) => n + l.length, 0);
  const recovered = collectLeaves(fileMap(files), topMeta, '', 0, total);
  assert.equal(recovered.length, leaves.length);
  assert.deepEqual(
    recovered,
    leaves.map((l) => ({ offset: l.offset, length: l.length, digest: toHex(l.digest) })),
  );

  // Every directory respects the fanout bound.
  for (const f of files) {
    if (f.path.endsWith('meta') || f.path === 'meta') {
      const depth = f.path.split('/').length - 1;
      const start = depth === 0 ? 0 : parseInt(f.path.split('/').at(-2), 16);
      assert.ok(decodeMeta(f.content, start).entries.length <= 4, `${f.path} over fanout`);
    }
  }
});

test('deterministic: same leaves, same bytes', () => {
  const leaves = makeLeaves([100, 200, 300, 400, 500]);
  const a = buildProofTree(leaves, { shardCap: 80 });
  const b = buildProofTree(leaves, { shardCap: 80 });
  assert.deepEqual(
    a.files.map((f) => [f.path, Buffer.from(f.content).toString('hex')]),
    b.files.map((f) => [f.path, Buffer.from(f.content).toString('hex')]),
  );
});

test('rejects non-contiguous or empty input', () => {
  assert.throws(() => buildProofTree([]), /no leaves/);
  assert.throws(
    () => buildProofTree([{ offset: 5, length: 10, digest: deterministicBytes(32, 1) }]),
    /not contiguous/,
  );
});
