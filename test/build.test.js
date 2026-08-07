import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { CID } from 'multiformats/cid';
import { VerifiedAsset, VerifiedSource } from 'veritiles';

import { directoryFetch } from '../scripts/lib/local-fetch.js';
import { parseArchive } from '../scripts/lib/pmtiles-parse.js';

const dataDir = new URL('../data/', import.meta.url);
const mapCid = 'bafyreiaxo6p3oqrt4lz4armeobbbqegrch2gddbwhorudmi2oiozkdlhgy';
const elevationCid = 'bafyreibjxxemhc4chmic627vfl3a3emlfoo7ncwzwe2iuif5ybrwnflqga';
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

test('v0.3.1 proofs authenticate both PMTiles archives and bind UnixFS roots', async () => {
  for (const [cid, source] of [[mapCid, 'map.pmtiles'], [elevationCid, 'elevation.pmtiles']]) {
    const descriptor = await readFile(new URL(`${source}.proofs/root`, dataDir));
    assert.equal(unixfsCid(descriptor).code, 0x70);
    const verified = new VerifiedSource({ cid, source, fetchFn });
    await verified.ready();
    const bytes = new Uint8Array((await verified.getBytes(0, 16384)).data);
    assert.equal(bytes.length, 16384);
    assert.ok(verified.stats.verified > 0);
  }
});

function unixfsCid(descriptor) {
  const marker = Buffer.from([0x66, 0x75, 0x6e, 0x69, 0x78, 0x66, 0x73, 0xd8, 0x2a, 0x58, 0x25, 0x00]);
  const start = descriptor.indexOf(marker);
  assert.notEqual(start, -1, 'descriptor has no UnixFS bridge');
  return CID.decode(descriptor.subarray(start + marker.length, start + marker.length + 36));
}

test('the MASL font bundle authenticates a glyph', async () => {
  const fonts = new VerifiedAsset({ cid: fontsCid, source: 'fonts', fetchFn });
  const glyph = await fonts.bytes('Noto Sans Regular/0-255.pbf');
  const expected = await readFile(join(new URL('.', dataDir).pathname, 'fonts', 'Noto Sans Regular', '0-255.pbf'));
  assert.deepEqual(glyph, new Uint8Array(expected));
  assert.ok(fonts.stats.verified > 0);
});
