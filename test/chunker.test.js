import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cutPointChunker } from '../scripts/lib/chunker.js';
import { deterministicBytes } from './helpers.js';

async function collect(chunker, buffers) {
  const out = [];
  for await (const chunk of chunker(buffers)) out.push(chunk);
  return out;
}

test('cuts exactly at the planned lengths regardless of input buffering', async () => {
  const data = deterministicBytes(1000);
  const plan = [1, 126, 300, 573];
  for (const bufSize of [1, 7, 128, 1000]) {
    const buffers = [];
    for (let i = 0; i < data.length; i += bufSize) {
      buffers.push(data.subarray(i, i + bufSize));
    }
    const blocks = await collect(cutPointChunker(plan), buffers);
    assert.deepEqual(blocks.map((b) => b.length), plan);
    assert.deepEqual(Buffer.concat(blocks), Buffer.from(data));
  }
});

test('rejects input longer than the plan', async () => {
  await assert.rejects(
    collect(cutPointChunker([4]), [deterministicBytes(5)]),
    /longer than the cut-point plan/,
  );
});

test('rejects input ending mid-block', async () => {
  await assert.rejects(
    collect(cutPointChunker([4, 4]), [deterministicBytes(6)]),
    /ended mid-block/,
  );
});

test('rejects input missing whole blocks', async () => {
  await assert.rejects(
    collect(cutPointChunker([4, 4]), [deterministicBytes(4)]),
    /shorter than the cut-point plan/,
  );
});
