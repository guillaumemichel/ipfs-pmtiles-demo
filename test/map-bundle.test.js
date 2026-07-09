import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MapBundle } from '../src/map-bundle.js';
import { deterministicBytes, flipByte, rangeFetch, testMapBundle } from './helpers.js';

const mapBytes = deterministicBytes(4000, 30);
const fixture = await testMapBundle({ mapBytes, cuts: [1000, 2000, 1000] });

function openBundle(opts = {}) {
  return MapBundle.open(fixture.rootCid, [{ type: 'range', url: '.' }], {
    ...opts,
    fetchFn: rangeFetch(opts.files ?? fixture.files, opts),
  });
}

test('pmtilesSource serves verified byte ranges', async () => {
  const bundle = await openBundle();
  const source = bundle.pmtilesSource();
  assert.equal(source.getKey(), fixture.rootCid);
  const { data } = await source.getBytes(900, 1200); // spans two leaves
  assert.deepEqual(new Uint8Array(data), mapBytes.subarray(900, 2100));
});

test('opening with a wrong root CID fails reconstruction', async () => {
  const other = fixture.dag.mapEntry.cid.toString();
  await assert.rejects(
    MapBundle.open(other, [{ type: 'range', url: '.' }], {
      fetchFn: rangeFetch(fixture.files),
    }),
    /does not reconstruct/,
  );
});

test('open fails when metadata.json is missing', async () => {
  const files = new Map(fixture.files);
  files.delete('metadata.json');
  await assert.rejects(
    MapBundle.open(fixture.rootCid, [{ type: 'range', url: '.' }], {
      fetchFn: rangeFetch(files),
    }),
    AggregateError,
  );
});

test('an unknown source type is rejected', async () => {
  await assert.rejects(
    MapBundle.open(fixture.rootCid, [{ type: 'gateway', url: '.' }]),
    /unknown source type/,
  );
});

test('stats count verified hashes', async () => {
  const bundle = await openBundle();
  await bundle.pmtilesSource().getBytes(0, 4000);
  // proofs meta + shard + 3 leaves at minimum.
  assert.ok(bundle.stats.verified >= 5);
  assert.equal(bundle.stats.rejected, 0);
});

test('a tampered tile range is rejected', async () => {
  // Corrupt only ranged (tile) responses; plain GETs (metadata.json, proofs)
  // pass untouched.
  const bundle = await openBundle({
    tamper: (path, range, bytes) =>
      path === 'map.pmtiles' && range ? flipByte(bytes) : bytes,
  });
  await assert.rejects(bundle.pmtilesSource().getBytes(0, 1000), AggregateError);
  assert.ok(bundle.stats.rejected > 0);
});
