// Reproducibility guard over the real archives, font set, and style: parsing
// matches the measured facts, and the build reproduces the golden CIDs and
// proof digests — same inputs → same trust anchors. The client-side
// verification these anchors drive now lives in the veritiles library and is
// tested there; here we only pin the publisher output.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

import { assembleMapBundle, ELEVATION_SOURCE_BUILD, MAP_SOURCE_BUILD } from '../scripts/lib/bundle.js';
import { assembleFontAsset } from '../scripts/lib/font-asset.js';
import { parseArchive } from '../scripts/lib/pmtiles-parse.js';
import { buildStyle } from '../scripts/lib/style.js';

const RAW_CODE = 0x55;
const PROOF_CAP_BYTES = 262_144;

const GOLDEN_MAP_ROOT_CID = 'bafybeihnila5l5dabqrbpvaictnce5wop364y5kbc7kfowbnd5mbnpayci';
const GOLDEN_FILE_CID = 'bafybeigulyyqowdlgyepgnw3ido3ewz7skb5dghs3atcnzvinsjnbtvfvm';
const GOLDEN_META_DIGEST = 'b0776b07b122eb11d916c51afa57fffee3142a6bd5de11551a57ee34081da1f4';
const GOLDEN_ELEVATION_ROOT_CID = 'bafybeibohr6uv6wyovbqj3j5rec33qezoybzwfvtylc36sly4bcg23zlmq';
const GOLDEN_ELEVATION_FILE_CID = 'bafybeiepeifqnixd73lijrdq4j7f5vgzcff6yj5f2hhxb7uxffjvsml5lu';
const GOLDEN_ELEVATION_META_DIGEST =
  '90b87d5b778fa082fe3f587bb623a793c261a53614a8f06fe41275fe09d24a56';
// The verified-asset anchors (veritiles SPEC.md Part 2): the fonts directory root, its
// CAR proof anchor, and the raw style CID. Freeze — drift means the §9 import
// profile, the proof builder, or the style template changed.
const GOLDEN_FONTS_ROOT_CID = 'bafybeigknf3p3vc5eq2q4odydrxhaxv7rtm74y53z3tobajkzdrx4gt4ia';
const GOLDEN_FONTS_ANCHOR = 'bagbaierarhezbhsdwonl6fpyhbu42rawgnwlqax7y7ajydtw3v2gefozogkq';
const GOLDEN_STYLE_CID = 'bafkreif5kaqrmfvu5afwjx76t5mzyw2fymiq2sdchv2dm54i7ql7bebjbm';

// The veritiles SPEC.md A5 header: 18-byte prefix, 32-byte root digest, 9-byte
// suffix — what a standard CAR writer must emit for a dag-pb root.
const HEADER_PREFIX = Uint8Array.from([
  0x3a, 0xa2, 0x65, 0x72, 0x6f, 0x6f, 0x74, 0x73, 0x81,
  0xd8, 0x2a, 0x58, 0x25, 0x00, 0x01, 0x70, 0x12, 0x20,
]);
const HEADER_SUFFIX = Uint8Array.from([0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x01]);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fileBytes = await readFile(join(repo, 'data/map.pmtiles'));
const { header, entries, tileRanges } = parseArchive(fileBytes);
const elevationBytes = await readFile(join(repo, 'data/elevation.pmtiles'));
const elevationArchive = parseArchive(elevationBytes);

// One assembly per artifact shared across the golden assertions (the map and
// elevation archives are full ~44 MB / ~62 MB imports).
const map = await assembleMapBundle({ fileBytes, sourceBuild: MAP_SOURCE_BUILD });
const elevation = await assembleMapBundle({
  fileBytes: elevationBytes,
  sourceBuild: ELEVATION_SOURCE_BUILD,
});
const fonts = await assembleFontAsset(join(repo, 'data/fonts'));

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

test('elevation archive facts match the measured anatomy', () => {
  const { header: h, entries: e, tileRanges: t } = elevationArchive;
  assert.equal(elevationBytes.length, 61_961_078);
  assert.equal(h.rootDirectoryLength, 942);
  assert.equal(h.tileDataOffset, 1160);
  assert.equal(h.leafDirectoryLength, 0);
  assert.equal(h.clustered, true);
  assert.equal(h.tileType, 4); // webp terrarium raster-dem tiles
  assert.equal(h.maxZoom, 4);
  assert.equal(e.length, 304);
  assert.equal(t.length, 299);
});

test('assembleMapBundle reproduces the golden elevation CIDs', () => {
  assert.equal(elevation.mapEntry.cid.toString(), GOLDEN_ELEVATION_FILE_CID);
  assert.equal(elevation.root.cid.toString(), GOLDEN_ELEVATION_ROOT_CID);
});

test('the elevation proofs tree is 1 shard + 1 meta, under the cap', () => {
  assert.equal(elevation.proofTree.shardCount, 1);
  assert.equal(elevation.proofTree.files.length, 2);
  for (const f of elevation.proofTree.files) {
    assert.ok(f.content.length <= 64 * 1024, `${f.path}: ${f.content.length} B over cap`);
  }
  assert.equal(
    createHash('sha256').update(elevation.proofTree.topMeta).digest('hex'),
    GOLDEN_ELEVATION_META_DIGEST,
  );
});

test('the proofs tree is 2 shards + 1 meta, every file under the cap', () => {
  assert.equal(map.proofTree.shardCount, 2);
  assert.equal(map.proofTree.files.length, 3);
  for (const f of map.proofTree.files) {
    assert.ok(f.content.length <= 64 * 1024, `${f.path}: ${f.content.length} B over cap`);
  }
  assert.equal(createHash('sha256').update(map.proofTree.topMeta).digest('hex'), GOLDEN_META_DIGEST);
});

test('leaf 0 spans the header + directories, leaf 1 the first tile', () => {
  assert.equal(map.leaves[0].offset, 0);
  assert.equal(map.leaves[0].length, header.tileDataOffset);
  assert.equal(map.leaves[1].offset, header.tileDataOffset);
});

test('the fonts asset reproduces the golden root + CAR anchor', () => {
  assert.equal(fonts.fileCount, 256);
  assert.equal(fonts.root, GOLDEN_FONTS_ROOT_CID);
  assert.equal(fonts.anchor, GOLDEN_FONTS_ANCHOR);
  // car codec anchor over a dag-pb root; content root stays dag-pb.
  assert.equal(CID.parse(fonts.anchor).code, 0x0202);
  assert.equal(fonts.rootCid.code, 0x70);
});

test('the fonts proof is a strict §5 CAR: under cap, header template, dag-pb sections', () => {
  assert.ok(fonts.proof.length <= PROOF_CAP_BYTES, `${fonts.proof.length} B over cap`);
  const expectedHeader = Buffer.concat([
    Buffer.from(HEADER_PREFIX),
    Buffer.from(fonts.rootCid.multihash.digest),
    Buffer.from(HEADER_SUFFIX),
  ]);
  assert.deepEqual(Buffer.from(fonts.proof.subarray(0, expectedHeader.length)), expectedHeader);
  // The proof is structure only (no raw leaves): the two dag-pb directory
  // nodes — the fonts root and the single glyph-stack directory.
  const dagPbBlocks = [...fonts.blockstore.blocks.values()].filter((b) => b.cid.code === 0x70);
  assert.equal(dagPbBlocks.length, 2);
});

test('the style asset reproduces the golden raw CID and bakes the built references', async () => {
  const styleObj = buildStyle({
    mapRoot: map.root.cid.toString(),
    fontsAnchor: fonts.anchor,
    elevationMaxZoom: elevationArchive.header.maxZoom,
  });
  const styleBytes = Buffer.from(`${JSON.stringify(styleObj, null, 2)}\n`);
  assert.ok(styleBytes.length <= 256 * 1024);
  const styleCid = CID.createV1(RAW_CODE, await sha256.digest(styleBytes));
  assert.equal(styleCid.code, RAW_CODE);
  assert.equal(styleCid.toString(), GOLDEN_STYLE_CID);

  assert.equal(styleObj.sources['pmtiles-source'].url, `pmtiles://${GOLDEN_MAP_ROOT_CID}`);
  assert.equal(styleObj.glyphs, `verified://${GOLDEN_FONTS_ANCHOR}/{fontstack}/{range}.pbf`);
  assert.equal(styleObj.sources.terrainSource.maxzoom, 4);
});
