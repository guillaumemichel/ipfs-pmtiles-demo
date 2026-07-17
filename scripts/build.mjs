#!/usr/bin/env node
// Build the deployable static site. Two range-verified packages — the vector
// map and the elevation archive — each a tile-aligned UnixFS DAG over its
// .pmtiles file + a sharded proofs/ tree + metadata.json, read in the browser
// by veritiles' VerifiedSource. Two verified assets (veritiles SPEC.md Part 2) — the
// font glyphs (a UnixFS directory anchored by a structure-only CAR proof) and
// the style (a raw ≤ 256 KiB file, self-verifying) — read by veritiles'
// VerifiedAsset. Everything is content-addressed; the page carries only the
// five CIDs as trust anchors, drift-guarded against this build.
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createWriteStream } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { VerifiedAsset, VerifiedSource } from 'veritiles';

import { assembleMapBundle, ELEVATION_SOURCE_BUILD, MAP_SOURCE_BUILD } from './lib/bundle.js';
import { writeCar } from './lib/dag-build.js';
import { assembleFontAsset } from './lib/font-asset.js';
import { directoryFetch } from './lib/local-fetch.js';
import { buildStyle } from './lib/style.js';

const RAW_CODE = 0x55;
const RAW_ARTIFACT_CAP = 256 * 1024; // §2: a raw artifact names a single raw block

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(repoRoot, 'data');
const outDir = join(repoRoot, 'build');
const distDir = join(repoRoot, 'dist');

async function main() {
  const mapPath = join(dataDir, 'map.pmtiles');
  const elevationPath = join(dataDir, 'elevation.pmtiles');
  const mapBytes = await readFile(mapPath);
  const elevationBytes = await readFile(elevationPath);

  // 1. The two range-verified packages (see scripts/lib/bundle.js) — same
  // package kind, one verified range-readable file each, from different
  // upstream sources.
  const map = await assembleMapBundle({ fileBytes: mapBytes, sourceBuild: MAP_SOURCE_BUILD });
  const elevation = await assembleMapBundle({
    fileBytes: elevationBytes,
    sourceBuild: ELEVATION_SOURCE_BUILD,
  });
  for (const [name, pkg, bytes] of [['map', map, mapBytes], ['elevation', elevation, elevationBytes]]) {
    verifyLeafReassembly(pkg.leaves, pkg.blockstore, bytes);
    console.log(`${name}: ${pkg.tileRanges.length} unique tile ranges; file CID ${pkg.mapEntry.cid}`);
  }
  const MAP_ROOT = map.root.cid.toString();
  const ELEVATION_ROOT = elevation.root.cid.toString();

  // 2. Fonts as a verified asset: import data/fonts under the §9 profile so
  // FONTS_ROOT is the glyph directory itself (gateway-path compatible), then
  // emit its structure-only CAR proof. Trust travels as the CAR anchor.
  const fonts = await assembleFontAsset(join(dataDir, 'fonts'));
  console.log(
    `fonts: ${fonts.fileCount} glyph files; root ${fonts.root}; ` +
      `proof ${fonts.proof.length} B; anchor ${fonts.anchor}`,
  );

  // 3. Style as a raw asset: bake the built CIDs (and the elevation archive's
  // own maxzoom) into the MapLibre style, publish the bytes at STYLE_CID.
  const styleObj = buildStyle({
    mapRoot: MAP_ROOT,
    fontsAnchor: fonts.anchor,
    elevationMaxZoom: elevation.header.maxZoom,
  });
  const styleBytes = Buffer.from(`${JSON.stringify(styleObj, null, 2)}\n`);
  if (styleBytes.length > RAW_ARTIFACT_CAP) {
    throw new Error(`style is ${styleBytes.length} B, over the ${RAW_ARTIFACT_CAP} B raw-artifact cap (§2)`);
  }
  const styleCid = CID.createV1(RAW_CODE, await sha256.digest(styleBytes));
  if (styleCid.code !== RAW_CODE) throw new Error(`style CID codec is not raw: ${styleCid.code}`);
  const STYLE_CID = styleCid.toString();
  console.log(`style: ${styleBytes.length} B; CID ${STYLE_CID}`);

  const values = {
    map: MAP_ROOT,
    elevation: ELEVATION_ROOT,
    fontsRoot: fonts.root,
    fontsAnchor: fonts.anchor,
    style: STYLE_CID,
  };
  console.log(`MAP_ROOT ${MAP_ROOT}`);
  console.log(`ELEVATION_ROOT ${ELEVATION_ROOT}`);
  console.log(`FONTS_ROOT ${fonts.root}`);
  console.log(`FONTS_ANCHOR ${fonts.anchor}`);
  console.log(`STYLE_CID ${STYLE_CID}`);

  // 4. One all-block CAR per package — the IPFS-publication + pin artifacts.
  // Distinct from the structure-only proof shipped inside dist/.
  await mkdir(outDir, { recursive: true });
  for (const [name, root, blocks] of [
    ['map', map.root.cid, map.blockstore.blocks],
    ['elevation', elevation.root.cid, elevation.blockstore.blocks],
    ['fonts', fonts.rootCid, fonts.blockstore.blocks],
  ]) {
    const carPath = join(outDir, `${name}.car`);
    await writeCarFile(root, blocks, carPath);
    console.log(`wrote ${relative(repoRoot, carPath)} (${blocks.size} blocks)`);
  }

  // 5. Optional Kubo byte-identity check (publication stays possible, same
  // root CIDs — but nothing in the serving path needs it).
  if (process.argv.includes('--pin')) {
    pinAndVerify([['map', map.mapEntry.cid, mapPath], ['elevation', elevation.mapEntry.cid, elevationPath]]);
  } else {
    console.log('skipping Kubo import (pass --pin to import + byte-verify)');
  }

  // 6. Assemble dist/ — a complete self-contained static site: the page and
  // vendored client alongside the packages and assets, each under
  // ipfs/<id>/… (what `ipfs get <id>` produces; the id in the path is a
  // legibility/interop convention, not a trust input).
  await rm(distDir, { recursive: true, force: true });
  await assembleMapDist(join(distDir, 'ipfs', MAP_ROOT), map, mapPath);
  await assembleMapDist(join(distDir, 'ipfs', ELEVATION_ROOT), elevation, elevationPath);
  await assembleFontDist(fonts);
  await writeFile(join(distDir, 'ipfs', STYLE_CID), styleBytes);
  await assembleSite(values);
  console.log(`assembled ${relative(repoRoot, distDir)}/ (page + client + map + elevation + fonts + style)`);

  // 7. Prove dist/ serves every package and asset through the real veritiles
  // resolvers over an in-process dumb host — nothing but GET + Range.
  await verifyRoundTrip({ map, elevation, mapBytes, elevationBytes, fonts, styleObj, values });
  console.log('dist/ round-trip: tiles + style + glyph verify; a tampered glyph rejects');
}

// Write the page and vendored veritiles into dist/, asserting index.html's
// inlined config still matches this build — the drift guard that lets the page
// carry its five trust anchors inline instead of fetching a config file. Each
// CID is anchored to its config key so no two-value swap can slip through.
async function assembleSite(values) {
  const indexHtml = await readFile(join(repoRoot, 'index.html'), 'utf8');
  for (const [key, cid] of Object.entries(values)) {
    if (!new RegExp(`${key}:\\s*'${cid}'`).test(indexHtml)) {
      throw new Error(
        `index.html config.${key} does not match the built CID ${cid} — ` +
          'update the inlined config in index.html to match this build',
      );
    }
  }
  await writeFile(join(distDir, 'index.html'), indexHtml);
  await mkdir(join(distDir, 'vendor'), { recursive: true });
  await copyFile(
    join(repoRoot, 'node_modules', 'veritiles', 'dist', 'index.js'),
    join(distDir, 'vendor', 'veritiles.js'),
  );
}

async function writeCarFile(rootCid, blocks, path) {
  const out = createWriteStream(path);
  await writeCar(rootCid, blocks, out);
  await new Promise((res, rej) => out.close((e) => (e ? rej(e) : res())));
}

async function assembleMapDist(dir, map, mapPath) {
  await mkdir(dir, { recursive: true });
  await copyFile(mapPath, join(dir, 'map.pmtiles'));
  await writeFile(join(dir, 'metadata.json'), map.metadataBytes);
  for (const { path, content } of map.proofTree.files) {
    const target = join(dir, 'proofs', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

// The glyph directory is mirrored as plain files under its own root CID, with
// the structure-only proof beside it at <root>.car (veritiles SPEC.md A3).
async function assembleFontDist(fonts) {
  const dir = join(distDir, 'ipfs', fonts.root);
  await cp(fonts.fontsDir, dir, { recursive: true });
  await writeFile(join(distDir, 'ipfs', `${fonts.root}.car`), fonts.proof);
}

async function verifyRoundTrip({ map, elevation, mapBytes, elevationBytes, fonts, styleObj, values }) {
  await verifyMapRoundTrip(values.map, map, mapBytes);
  await verifyMapRoundTrip(values.elevation, elevation, elevationBytes);
  await verifyStyleRoundTrip(values, styleObj);
  await verifyFontRoundTrip(values, fonts);
}

async function verifyMapRoundTrip(rootCid, map, fileBytes) {
  const source = new VerifiedSource({
    rootCid,
    source: `ipfs/${rootCid}`,
    fetchFn: directoryFetch(distDir),
  });

  // pmtiles.js's first read spans leaves 0 + 1: exercises the multi-leaf run.
  const boot = await source.getBytes(0, 16384);
  assertBytesEqual(new Uint8Array(boot.data), fileBytes.subarray(0, 16384), 'bootstrap');

  const { tileRanges, header } = map;
  const samples = [0, 1, Math.floor(tileRanges.length / 2), tileRanges.length - 1];
  for (const i of samples) {
    const { offset, length } = tileRanges[i];
    const abs = header.tileDataOffset + offset;
    const got = await source.getBytes(abs, length);
    assertBytesEqual(new Uint8Array(got.data), fileBytes.subarray(abs, abs + length), `tile ${i}`);
  }
}

async function verifyStyleRoundTrip(values, styleObj) {
  const asset = new VerifiedAsset({
    cid: values.style,
    source: `ipfs/${values.style}`,
    fetchFn: directoryFetch(distDir),
  });
  const parsed = JSON.parse(new TextDecoder().decode(await asset.bytes('')));
  const url = parsed.sources?.['pmtiles-source']?.url;
  if (url !== `pmtiles://${values.map}`) throw new Error(`style pmtiles url is ${url}`);
  if (parsed.glyphs !== styleObj.glyphs) throw new Error(`style glyphs is ${parsed.glyphs}`);
  if (!parsed.glyphs.startsWith(`verified://${values.fontsAnchor}/`)) {
    throw new Error(`style glyphs not anchored to FONTS_ANCHOR: ${parsed.glyphs}`);
  }
}

async function verifyFontRoundTrip(values, fonts) {
  const glyphPath = 'Noto Sans Regular/0-255.pbf';
  const expected = await readFile(join(fonts.fontsDir, glyphPath));

  const asset = new VerifiedAsset({
    cid: values.fontsAnchor,
    source: `ipfs/${values.fontsRoot}`,
    fetchFn: directoryFetch(distDir),
  });
  const glyph = await asset.bytes(glyphPath);
  assertBytesEqual(glyph, expected, 'glyph');

  // A missing glyph is an authenticated absence, not an error of the host.
  await assertRejectsWith(
    asset.bytes('Noto Sans Regular/absent.pbf'),
    'NotFoundError',
    'absent glyph -> NotFoundError',
  );

  // A flipped byte in a glyph response must reject against the proof. With a
  // single (tampered) source the store bans it and throws an AggregateError
  // wrapping the VerificationError — the same shape the page classifies.
  const tampered = new VerifiedAsset({
    cid: values.fontsAnchor,
    source: `ipfs/${values.fontsRoot}`,
    fetchFn: flipGlyphBytes(distDir),
  });
  await assertRejectsWith(tampered.bytes(glyphPath), 'VerificationError', 'tampered glyph -> reject');
  if (tampered.stats.rejected < 1) throw new Error('tampered glyph did not count a rejection');
}

// A dumb host that corrupts the first byte of every glyph response — the
// build-time analogue of ?tamper=1, for the reject-path assertion.
function flipGlyphBytes(dir) {
  const base = directoryFetch(dir);
  return async (url, opts) => {
    const res = await base(url, opts);
    if (!res.ok || !url.endsWith('.pbf')) return res;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > 0) bytes[0] ^= 0xff;
    return new Response(bytes, { status: res.status });
  };
}

function assertBytesEqual(a, b, label) {
  if (a.length !== b.length || Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) {
    throw new Error(`dist round-trip mismatch (${label}): ${a.length} vs ${b.length} bytes`);
  }
}

// Accept a reject whose error tree (an AggregateError's members, or a cause
// chain) contains the named error — the same match the page's error panel makes.
async function assertRejectsWith(promise, name, label) {
  try {
    await promise;
  } catch (err) {
    if (findErrorByName(err, name)) return;
    throw new Error(`${label}: threw ${err?.name ?? err}, no ${name} in the tree`);
  }
  throw new Error(`${label}: did not reject`);
}

function findErrorByName(err, name, depth = 0) {
  if (!err || depth > 6) return null;
  if (err.name === name) return err;
  for (const e of err.errors ?? []) {
    const found = findErrorByName(e, name, depth + 1);
    if (found) return found;
  }
  return findErrorByName(err.cause, name, depth + 1);
}

// In-memory equivalent of `ipfs cat | cmp`: concatenated leaf blocks must be
// byte-identical to the source file — and therefore so are the proof digests
// derived from their CIDs.
function verifyLeafReassembly(leaves, blockstore, fileBytes) {
  const raw = [...blockstore.blocks.values()].filter((b) => b.cid.code === RAW_CODE);
  const byDigest = new Map(raw.map((b) => [Buffer.from(b.cid.multihash.digest).toString('hex'), b]));
  for (const { offset, length, digest } of leaves) {
    const block = byDigest.get(Buffer.from(digest).toString('hex'));
    if (block === undefined) throw new Error(`no block for leaf at offset ${offset}`);
    const expected = fileBytes.subarray(offset, offset + length);
    if (Buffer.compare(block.bytes, expected) !== 0) {
      throw new Error(`leaf at file offset ${offset} differs from source bytes`);
    }
  }
  const covered = leaves.reduce((n, l) => n + l.length, 0);
  if (covered !== fileBytes.length) {
    throw new Error(`leaves cover ${covered} bytes, file is ${fileBytes.length}`);
  }
}

// Import every package CAR, then byte-verify each archive ([name, fileCid,
// filePath]) through ipfs cat.
function pinAndVerify(archives) {
  for (const name of ['map', 'elevation', 'fonts']) {
    console.log(`importing ${name}.car into Kubo...`);
    execFileSync('ipfs', ['dag', 'import', join(outDir, `${name}.car`)], { stdio: 'inherit' });
  }
  for (const [name, fileCid, filePath] of archives) {
    console.log(`verifying ${name} byte identity via ipfs cat...`);
    execFileSync('sh', ['-c', `ipfs cat ${fileCid} | cmp - "${filePath}"`], { stdio: 'inherit' });
    console.log(`ipfs cat output is byte-identical to ${relative(repoRoot, filePath)}`);
  }
}

await main();
