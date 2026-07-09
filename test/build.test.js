// Reproducibility guard over the real archive and font set: parsing matches
// the measured facts, and the build reproduces the golden root CIDs, the
// golden map file CID (unchanged since the tile-aligned import was
// introduced), and the golden proofs digest — same inputs → same trust
// anchors → same proofs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { openFontManifest, openMapManifest } from '../src/bootstrap.js';
import { decodeFontProofs } from '../src/proof-format.js';
import { ProofIndex } from '../src/proof-index.js';
import { RangeSource } from '../src/range-source.js';
import { toHex } from '../src/verify.js';
import { VerifiedStore } from '../src/verified-store.js';
import { assembleFontBundle, assembleMapBundle, FONT_SET_PROVENANCE } from '../scripts/lib/bundle.js';
import { parseArchive } from '../scripts/lib/pmtiles-parse.js';
import { rangeFetch } from './helpers.js';

const GOLDEN_MAP_ROOT_CID = 'bafybeidromswvzgmm4hwagh6yn3ktbf2wajgfmt3zcqkt4oofmqw4wfkja';
const GOLDEN_FILE_CID = 'bafybeigulyyqowdlgyepgnw3ido3ewz7skb5dghs3atcnzvinsjnbtvfvm';
const GOLDEN_META_DIGEST = 'b0776b07b122eb11d916c51afa57fffee3142a6bd5de11551a57ee34081da1f4';
const GOLDEN_FONTS_ROOT_CID = 'bafybeigowai2gpk2sutzzsnnjt6hucdh7atuugoyfhjt3hbc2o3hkbjjbu';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fileBytes = await readFile(join(repo, 'data/map.pmtiles'));
const { header, entries, tileRanges } = parseArchive(fileBytes);

// One assembly per package shared across the golden assertions (the map is
// a full ~44 MB import).
const map = await assembleMapBundle({ fileBytes });
const fonts = await assembleFontBundle({
  fontsDir: join(repo, 'data/fonts'),
  provenance: FONT_SET_PROVENANCE,
});

// The published artifacts, served in-memory — what the dumb hosts would hold.
const mapServed = new Map([
  ['metadata.json', map.metadataBytes],
  ...map.proofTree.files.map((f) => [`proofs/${f.path}`, f.content]),
]);
const fontsServed = new Map([
  ['metadata.json', fonts.metadataBytes],
  ['proofs', fonts.proofsBytes],
]);

test('archive facts match the measured anatomy', () => {
  assert.equal(fileBytes.length, 44_199_060);
  assert.equal(header.rootDirectoryOffset, 127);
  assert.equal(header.rootDirectoryLength, 9324);
  assert.equal(header.tileDataOffset, 10_565);
  assert.equal(header.leafDirectoryLength, 0);
  assert.equal(header.clustered, true);
  assert.equal(entries.length, 3380);
  assert.equal(tileRanges.length, 2904);
});

test('assembleMapBundle reproduces the golden CIDs', () => {
  assert.equal(map.mapEntry.cid.toString(), GOLDEN_FILE_CID);
  assert.equal(map.root.cid.toString(), GOLDEN_MAP_ROOT_CID);
});

test('assembleFontBundle reproduces the golden root CID', () => {
  assert.equal(fonts.fontFiles.length, 256);
  assert.equal(fonts.root.cid.toString(), GOLDEN_FONTS_ROOT_CID);
});

test('the proofs tree is 2 shards + 1 meta, every file under the cap', () => {
  assert.equal(map.proofTree.shardCount, 2);
  assert.equal(map.proofTree.files.length, 3);
  for (const f of map.proofTree.files) {
    assert.ok(f.content.length <= 64 * 1024, `${f.path}: ${f.content.length} B over cap`);
  }
  assert.equal(
    createHash('sha256').update(map.proofTree.topMeta).digest('hex'),
    GOLDEN_META_DIGEST,
  );
});

test('the map client bootstraps from rootCID + metadata.json alone', async () => {
  const store = new VerifiedStore([new RangeSource('.', { fetchFn: rangeFetch(mapServed) })]);
  const manifest = await openMapManifest(GOLDEN_MAP_ROOT_CID, store);
  assert.equal(manifest.mapSize, 44_199_060);
  assert.equal(manifest.proofsMetaDigest, GOLDEN_META_DIGEST);

  // Full proof descent recovers every leaf digest the DAG committed to.
  const index = new ProofIndex(store, {
    dir: manifest.proofsDir,
    metaDigest: manifest.proofsMetaDigest,
    fileSize: manifest.mapSize,
  });
  const recovered = await index.leavesFor(0, manifest.mapSize);
  assert.equal(recovered.length, map.leaves.length);
  assert.deepEqual(
    recovered.slice(0, 3),
    map.leaves.slice(0, 3).map((l) => ({ offset: l.offset, length: l.length, digest: toHex(l.digest) })),
  );
  const covered = recovered.reduce((n, l) => n + l.length, 0);
  assert.equal(covered, manifest.mapSize);
});

test('the font client bootstraps and the proofs cover every font file', async () => {
  const store = new VerifiedStore([new RangeSource('.', { fetchFn: rangeFetch(fontsServed) })]);
  const manifest = await openFontManifest(GOLDEN_FONTS_ROOT_CID, store);
  assert.equal(manifest.fontsDir, 'fonts');

  const table = decodeFontProofs(
    await store.fetchWhole(manifest.proofsFile, manifest.proofsDigest, 256 * 1024),
  );
  assert.equal(table.size, fonts.fontFiles.length);
  for (const { path, content } of fonts.fontFiles) {
    const digest = createHash('sha256').update(content).digest('hex');
    assert.equal(table.get(path.replace(/^fonts\//, '')), digest, path);
  }
});

test('leaf 0 spans the header + directories, leaf 1 the first tile', () => {
  assert.equal(map.leaves[0].offset, 0);
  assert.equal(map.leaves[0].length, header.tileDataOffset);
  assert.equal(map.leaves[1].offset, header.tileDataOffset);
});
