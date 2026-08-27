#!/usr/bin/env node
// Assemble the static v0.4.0 site. The PMTiles archives and their proof
// directories come from veritiles' published pack tool; this script publishes
// them, derives the routing-hints documents that locate every artifact, and
// then reads the whole site back through the released client configured exactly
// as the page is — anchors only, no location configured anywhere.
import { Buffer } from 'node:buffer';
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { VerifiedAsset, VerifiedSource } from 'veritiles';

import { directoryFetch } from './lib/local-fetch.js';
import { parseArchive } from './lib/pmtiles-parse.js';
import { buildStyle } from './lib/style.js';
import { carBlockCount, manifestOnlyCar } from './lib/thin-car.js';

const RAW_CODE = 0x55;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(repoRoot, 'data');
const distDir = join(repoRoot, 'dist');

const anchors = {
  map: 'bafyreiaxo6p3oqrt4lz4armeobbbqegrch2gddbwhorudmi2oiozkdlhgy',
  elevation: 'bafyreibjxxemhc4chmic627vfl3a3emlfoo7ncwzwe2iuif5ybrwnflqga',
  fonts: 'bafyreigr3kszmxht36pxnoddfdraxqnyy4x7ylnqyfnubenpdyqftozamm',
};

// `directoryFetch` keys on the path alone; the origin exists only to give the
// hints documents a base for their relative URLs, as the deployed page's own
// origin does. The glyph document is never named — the client finds it by
// probing the directory holding the proof CAR (veritiles SPEC.md §5).
const distOrigin = 'http://dist.invalid';
const pageHints = `${distOrigin}/hints.json`;
const glyphHints = `${distOrigin}/assets/hints.json`;

async function main() {
  const mapBytes = await readFile(join(dataDir, 'map.pmtiles'));
  const elevationBytes = await readFile(join(dataDir, 'elevation.pmtiles'));
  const elevation = parseArchive(elevationBytes);
  const style = buildStyle({
    mapAnchor: anchors.map,
    fontsAnchor: anchors.fonts,
    elevationMaxZoom: elevation.header.maxZoom,
  });
  const styleBytes = Buffer.from(`${JSON.stringify(style, null, 2)}\n`);
  const styleCid = await rawCid(styleBytes);
  const glyphs = await collectGlyphs();

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  await copyFile(join(dataDir, 'map.pmtiles'), join(distDir, 'map.pmtiles'));
  await cp(join(dataDir, 'map.pmtiles.proofs'), join(distDir, 'map.pmtiles.proofs'), { recursive: true });
  await copyFile(join(dataDir, 'elevation.pmtiles'), join(distDir, 'elevation.pmtiles'));
  await cp(join(dataDir, 'elevation.pmtiles.proofs'), join(distDir, 'elevation.pmtiles.proofs'), { recursive: true });

  await mkdir(join(distDir, 'assets'), { recursive: true });
  await cp(join(dataDir, 'fonts'), join(distDir, 'assets', 'fonts'), { recursive: true });
  await writeFile(join(distDir, 'assets', 'style.json'), styleBytes);
  // Publish the bundle *proof*, not a second copy of the glyphs. Idempotent, so
  // a future repack with a packer that still inlines everything is thinned here
  // rather than shipped; the assert keeps that guarantee honest.
  const fontsCar = await manifestOnlyCar(await readFile(join(dataDir, 'fonts.car')));
  const blocks = await carBlockCount(fontsCar);
  if (blocks !== 1) throw new Error(`fonts.car must be manifest-only, found ${blocks} blocks`);
  await writeFile(join(distDir, 'assets', 'fonts.car'), fontsCar);

  // Each archive is located by its own raw CID — the one its descriptor commits
  // to and the client looks up — recomputed here from the bytes being published.
  await writeFile(join(distDir, 'hints.json'), pageHintsDocument({
    map: await rawCid(mapBytes),
    elevation: await rawCid(elevationBytes),
    style: styleCid,
  }));
  await writeFile(join(distDir, 'assets', 'hints.json'), await glyphHintsDocument(glyphs));

  await mkdir(join(distDir, 'vendor'), { recursive: true });
  await copyFile(join(repoRoot, 'node_modules', 'veritiles', 'dist', 'index.js'), join(distDir, 'vendor', 'veritiles.js'));

  const pageTemplate = await readFile(join(repoRoot, 'index.html'), 'utf8');
  const stylePlaceholder = "style:     'STYLE_CID'";
  if (pageTemplate.split(stylePlaceholder).length !== 2) {
    throw new Error('index.html must contain exactly one style CID placeholder');
  }
  const page = pageTemplate.replace(stylePlaceholder, `style:     '${styleCid}'`);
  await writeFile(join(distDir, 'index.html'), page);

  // Read the site back the way the page does: anchors only, every location
  // resolved through the hints documents just written.
  const fetched = [];
  const disk = directoryFetch(distDir);
  const fetchFn = (url, opts) => {
    fetched.push(String(url));
    return disk(url, opts);
  };
  await verifyArchive(anchors.map, 'map.pmtiles', mapBytes, fetchFn);
  await verifyArchive(anchors.elevation, 'elevation.pmtiles', elevationBytes, fetchFn);
  await verifyAssets(styleCid, style, glyphs, fetchFn);
  assertReadShape(fetched, glyphs.length);

  console.log(`MAP_ANCHOR ${anchors.map}`);
  console.log(`ELEVATION_ANCHOR ${anchors.elevation}`);
  console.log(`FONTS_ANCHOR ${anchors.fonts}`);
  console.log(`STYLE_CID ${styleCid}`);
  console.log(`dist/: ${glyphs.length} glyphs verified against a ${fontsCar.length} B bundle proof; ` +
    'every archive, proof, style, and glyph located by hints.json and verified with veritiles v0.4.0');
}

async function rawCid(bytes) {
  return CID.createV1(RAW_CODE, await sha256.digest(bytes)).toString();
}

// Every file under data/fonts/, keyed as the bundle manifest names it: a
// '/'-joined path relative to the bundle root.
async function collectGlyphs() {
  const root = join(dataDir, 'fonts');
  const glyphs = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    glyphs.push({
      path: relative(root, absolute).split(sep).join('/'),
      bytes: await readFile(absolute),
    });
  }
  return glyphs.sort((a, b) => (a.path < b.path ? -1 : 1));
}

// The page's routing-hints document (veritiles SPEC.md §5): an untrusted map
// from CID to candidate locations, relative to the document itself so the whole
// site stays relocatable. A ranged package needs two entries — the anchor names
// the proof directory, the file's raw CID names the archive — an asset one.
function pageHintsDocument({ map, elevation, style }) {
  return document({
    [anchors.map]: ['map.pmtiles.proofs'],
    [map]: ['map.pmtiles'],
    [anchors.elevation]: ['elevation.pmtiles.proofs'],
    [elevation]: ['elevation.pmtiles'],
    [anchors.fonts]: ['assets/fonts.car'],
    [style]: ['assets/style.json'],
  });
}

// Where each glyph in the bundle lives, keyed by the raw CID the manifest gives
// it. This one is published *inside* assets/ rather than named by the page: the
// client probes the directory holding the proof CAR when a resource location is
// missing (SPEC.md §5 Discovery), so the page's own document stays six lines
// and this one is fetched only once a label actually needs a glyph.
async function glyphHintsDocument(glyphs) {
  const hints = {};
  for (const { path, bytes } of glyphs) {
    const url = path.split('/').map(encodeURIComponent).join('/');
    hints[await rawCid(bytes)] = [`fonts/${url}`];
  }
  return document(hints);
}

function document(hints) {
  return `${JSON.stringify({ hints }, null, 2)}\n`;
}

async function verifyArchive(cid, name, expected, fetchFn) {
  const file = new VerifiedSource({ cid, hints: pageHints, fetchFn });
  await file.ready();
  for (const [offset, length] of [[0, 16384], [Math.floor(expected.length / 2), 4096], [expected.length - 4096, 4096]]) {
    const got = new Uint8Array((await file.getBytes(offset, length)).data);
    const want = expected.subarray(offset, offset + length);
    if (!Buffer.from(got).equals(want)) throw new Error(`${name}: verified range differs from input`);
  }
}

async function verifyAssets(styleCid, style, glyphs, fetchFn) {
  const styleAsset = new VerifiedAsset({ cid: styleCid, hints: pageHints, fetchFn });
  const parsed = JSON.parse(new TextDecoder().decode(await styleAsset.bytes()));
  if (parsed.sources['pmtiles-source'].url !== style.sources['pmtiles-source'].url) {
    throw new Error('style asset did not round-trip');
  }
  // Every glyph, not a sample: each one is located through the probed document
  // and hashed against the manifest, so a stale hints entry cannot slip through.
  const fonts = new VerifiedAsset({ cid: anchors.fonts, hints: pageHints, fetchFn });
  for (const { path, bytes } of glyphs) {
    const glyph = await fonts.bytes(path);
    if (!Buffer.from(glyph).equals(bytes)) throw new Error(`glyph did not round-trip: ${path}`);
  }
}

// The published site must read the way the page needs it to: locations come
// only from hints documents, and glyph bytes come from the published files
// rather than from raw sections smuggled into the proof.
function assertReadShape(fetched, glyphCount) {
  for (const url of [pageHints, glyphHints, `${distOrigin}/assets/fonts.car`]) {
    if (!fetched.includes(url)) throw new Error(`the client never fetched ${url}`);
  }
  const glyphReads = fetched.filter((url) => url.endsWith('.pbf')).length;
  if (glyphReads !== glyphCount) {
    throw new Error(`expected ${glyphCount} glyph file reads, saw ${glyphReads}`);
  }
}

await main();
