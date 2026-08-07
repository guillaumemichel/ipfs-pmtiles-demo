import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { VerifiedAsset, VerifiedSource } from 'veritiles';

import { directoryFetch } from '../scripts/lib/local-fetch.js';
import { parseArchive } from '../scripts/lib/pmtiles-parse.js';

const dataDir = new URL('../data/', import.meta.url);
const mapCid = 'bafyreifxbxeu4m3xedbpgq5tx4k4ud4j2wxcpikg5dyzdxdhhy6zvcwo3u';
const elevationCid = 'bafyreiacny7rdvqj32fil5yxzvcurg6xb5bnhxn3zt53lemoala23x2hai';
const fontsCid = 'bafyreigr3kszmxht36pxnoddfdraxqnyy4x7ylnqyfnubenpdyqftozamm';
const fetchFn = directoryFetch(new URL('.', dataDir).pathname);

test('the PMTiles archives retain their measured facts', async () => {
  const map = await readFile(new URL('map.pmtiles', dataDir));
  const elevation = await readFile(new URL('elevation.pmtiles', dataDir));
  assert.equal(map.length, 44_199_060);
  assert.equal(parseArchive(map).header.maxZoom, 6);
  assert.equal(elevation.length, 61_961_078);
  assert.equal(parseArchive(elevation).header.maxZoom, 4);
});

test('v0.3.0 proofs authenticate both PMTiles archives', async () => {
  for (const [cid, source] of [[mapCid, 'map.pmtiles'], [elevationCid, 'elevation.pmtiles']]) {
    const verified = new VerifiedSource({ cid, source, fetchFn });
    await verified.ready();
    const bytes = new Uint8Array((await verified.getBytes(0, 16384)).data);
    assert.equal(bytes.length, 16384);
    assert.ok(verified.stats.verified > 0);
  }
});

test('the MASL font bundle authenticates a glyph', async () => {
  const fonts = new VerifiedAsset({ cid: fontsCid, source: 'fonts', fetchFn });
  const glyph = await fonts.bytes('Noto Sans Regular/0-255.pbf');
  const expected = await readFile(join(new URL('.', dataDir).pathname, 'fonts', 'Noto Sans Regular', '0-255.pbf'));
  assert.deepEqual(glyph, new Uint8Array(expected));
  assert.ok(fonts.stats.verified > 0);
});
