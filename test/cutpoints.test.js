import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeCutPoints, MAX_BLOCK_SIZE } from '../scripts/lib/cutpoints.js';

const header = (over = {}) => ({
  clustered: true,
  tileDataOffset: 100,
  tileDataLength: 900,
  ...over,
});

test('emits header block plus one block per tile range', () => {
  const tileRanges = [
    { offset: 0, length: 400 },
    { offset: 400, length: 500 },
  ];
  const cuts = computeCutPoints({ header: header(), tileRanges, fileSize: 1000 });
  assert.deepEqual(cuts, [100, 400, 500]);
});

test('splits ranges larger than the block maximum', () => {
  const tileRanges = [{ offset: 0, length: MAX_BLOCK_SIZE + 900 }];
  const cuts = computeCutPoints({
    header: header({ tileDataLength: MAX_BLOCK_SIZE + 900 }),
    tileRanges,
    fileSize: 100 + MAX_BLOCK_SIZE + 900,
  });
  assert.deepEqual(cuts, [100, MAX_BLOCK_SIZE, 900]);
});

test('rejects unclustered archives', () => {
  assert.throws(
    () => computeCutPoints({ header: header({ clustered: false }), tileRanges: [], fileSize: 1000 }),
    /not clustered/,
  );
});

test('rejects gaps between tile ranges', () => {
  const tileRanges = [
    { offset: 0, length: 400 },
    { offset: 450, length: 450 },
  ];
  assert.throws(
    () => computeCutPoints({ header: header(), tileRanges, fileSize: 1000 }),
    /gap or overlap at relative offset 450/,
  );
});

test('rejects overlapping tile ranges', () => {
  const tileRanges = [
    { offset: 0, length: 400 },
    { offset: 300, length: 600 },
  ];
  assert.throws(
    () => computeCutPoints({ header: header(), tileRanges, fileSize: 1000 }),
    /gap or overlap/,
  );
});

test('rejects ranges not covering the tile-data section', () => {
  const tileRanges = [{ offset: 0, length: 800 }];
  assert.throws(
    () => computeCutPoints({ header: header(), tileRanges, fileSize: 1000 }),
    /cover 800 bytes/,
  );
});

test('rejects tile data not ending at EOF', () => {
  assert.throws(
    () => computeCutPoints({ header: header(), tileRanges: [], fileSize: 1500 }),
    /does not end at EOF/,
  );
});
