import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openFontManifest, openMapManifest } from '../src/bootstrap.js';
import { RangeSource } from '../src/range-source.js';
import { VerificationError } from '../src/verify.js';
import { VerifiedStore } from '../src/verified-store.js';
import { deterministicBytes, flipByte, rangeFetch, testFontBundle, testMapBundle } from './helpers.js';

const mapFixture = await testMapBundle({
  mapBytes: deterministicBytes(4000, 30),
  cuts: [1000, 2000, 1000],
});
const fontFixture = await testFontBundle();

function storeOver(files, opts = {}) {
  return new VerifiedStore([new RangeSource('.', { fetchFn: rangeFetch(files, opts) })]);
}

// Serves handcrafted metadata.json bytes; for schema-validation tests that
// reject before any reconstruction happens.
const stubStore = (manifest) => ({
  fetchUnverified: async () => new TextEncoder().encode(JSON.stringify(manifest)),
});

const parseManifest = (fixture) =>
  JSON.parse(new TextDecoder().decode(fixture.files.get('metadata.json')));

test('map metadata.json alone reconstructs the root CID and yields the manifest', async () => {
  const manifest = await openMapManifest(mapFixture.rootCid, storeOver(mapFixture.files));
  assert.equal(manifest.mapFile, 'map.pmtiles');
  assert.equal(manifest.mapSize, 4000);
  assert.equal(manifest.proofsDir, 'proofs');
  assert.match(manifest.proofsMetaDigest, /^[0-9a-f]{64}$/);
  assert.equal(manifest.children.length, 2);
});

test('font metadata.json alone reconstructs the root CID and yields the manifest', async () => {
  const manifest = await openFontManifest(fontFixture.rootCid, storeOver(fontFixture.files));
  assert.equal(manifest.fontsDir, 'fonts');
  assert.equal(manifest.proofsFile, 'proofs');
  assert.match(manifest.proofsDigest, /^[0-9a-f]{64}$/);
  assert.equal(manifest.children.length, 2);
});

test('any tampered metadata.json byte fails reconstruction', async () => {
  for (const index of [0, 100, 200]) {
    const files = new Map(mapFixture.files);
    files.set('metadata.json', flipByte(mapFixture.files.get('metadata.json'), index));
    await assert.rejects(
      openMapManifest(mapFixture.rootCid, storeOver(files)),
      (err) => err.name === 'VerificationError' || err instanceof AggregateError,
      `byte ${index}`,
    );
  }
});

test('a different root CID rejects the same metadata.json', async () => {
  // A valid dag-pb CID that is not this package's root: the map file root.
  const other = mapFixture.dag.mapEntry.cid.toString();
  await assert.rejects(
    openMapManifest(other, storeOver(mapFixture.files)),
    /does not reconstruct/,
  );
  await assert.rejects(
    openFontManifest(mapFixture.rootCid, storeOver(fontFixture.files)),
    /does not reconstruct/,
  );
});

test('a raw (non-dag-pb) root CID is rejected up front', async () => {
  const raw = fontFixture.dag.children.find((c) => c.name === 'proofs').cid.toString();
  await assert.rejects(openMapManifest(raw, storeOver(mapFixture.files)), /must be dag-pb/);
});

test('child names that break dag-pb byte ordering fail closed as VerificationError', async () => {
  // '' < '\u{10000}' in UTF-16 (0xE000 < 0xD800-surrogate) but the
  // reverse in UTF-8 bytes (0xEE < 0xF0), so the client's UTF-16 sort hands
  // dag-pb's encoder an order it rejects. Must surface as a fail-closed
  // VerificationError, not a raw TypeError.
  const rawCid = fontFixture.dag.children.find((c) => c.name === 'proofs').cid.toString();
  const dirCid = fontFixture.dag.children.find((c) => c.name === 'fonts').cid.toString();
  const manifest = {
    formatVersion: 2,
    hash: 'sha2-256',
    fonts: { dir: '', proofs: '\u{10000}' },
    children: [
      { name: '', cid: dirCid, tsize: 1 },
      { name: '\u{10000}', cid: rawCid, tsize: 1 },
    ],
  };
  await assert.rejects(
    openFontManifest(fontFixture.rootCid, stubStore(manifest)),
    (err) => err.name === 'VerificationError' && /reconstruct root node/.test(err.message),
  );
});

test('a manifest of the other package kind is rejected', async () => {
  await assert.rejects(
    openMapManifest(fontFixture.rootCid, storeOver(fontFixture.files)),
    /invalid name for map.file/,
  );
  await assert.rejects(
    openFontManifest(mapFixture.rootCid, storeOver(mapFixture.files)),
    /invalid name for fonts.dir/,
  );
});

test('garbage JSON is rejected', async () => {
  const files = new Map(mapFixture.files);
  files.set('metadata.json', new TextEncoder().encode('not json'));
  await assert.rejects(openMapManifest(mapFixture.rootCid, storeOver(files)), /not valid UTF-8 JSON/);
});

test('map schema violations are rejected before reconstruction', async () => {
  const good = parseManifest(mapFixture);
  const cases = [
    [{ ...good, formatVersion: 99 }, /formatVersion/],
    [{ ...good, hash: 'sha3-512' }, /unsupported hash/],
    [{ ...good, map: { ...good.map, size: -1 } }, /invalid size/],
    [{ ...good, map: { ...good.map, file: 'a/b' } }, /invalid name/],
    [{ ...good, proofs: { ...good.proofs, metaDigest: 'zz' } }, /metaDigest/],
    [{ ...good, children: [] }, /children/],
    [{ ...good, children: good.children.slice(0, 1) }, /missing entry/],
    [
      { ...good, children: [...good.children, { name: 'metadata.json', cid: good.children[0].cid, tsize: 1 }] },
      /must not list metadata.json/,
    ],
    [
      { ...good, children: good.children.map((c) => ({ ...c, cid: 'not-a-cid' })) },
      /does not parse/,
    ],
  ];
  for (const [manifest, expected] of cases) {
    await assert.rejects(openMapManifest(mapFixture.rootCid, stubStore(manifest)), expected);
  }
});

test('font schema violations are rejected before reconstruction', async () => {
  const good = parseManifest(fontFixture);
  const cases = [
    [{ ...good, formatVersion: 1 }, /formatVersion/],
    [{ ...good, fonts: { ...good.fonts, dir: '' } }, /invalid name/],
    [{ ...good, fonts: { ...good.fonts, proofs: 'nope' } }, /missing entry/],
    // Pointing fonts.proofs at the fonts directory: a dag-pb child cannot
    // serve as a whole-file digest.
    [{ ...good, fonts: { ...good.fonts, proofs: 'fonts' } }, /raw sha2-256 leaf/],
  ];
  for (const [manifest, expected] of cases) {
    await assert.rejects(openFontManifest(fontFixture.rootCid, stubStore(manifest)), expected);
  }
});

test('every child value is load-bearing: altering any breaks reconstruction', async () => {
  const good = parseManifest(mapFixture);
  const mutations = [
    (m) => (m.children[0].tsize += 1),
    (m) => (m.children[1].cid = m.children[0].cid),
    (m) => m.children.splice(1, 1),
  ];
  for (const mutate of mutations) {
    const manifest = structuredClone(good);
    mutate(manifest);
    await assert.rejects(
      openMapManifest(mapFixture.rootCid, stubStore(manifest)),
      VerificationError,
    );
  }
});
