#!/usr/bin/env node
// Build the two verified packages — the map (tile-aligned UnixFS DAG over
// map.pmtiles + proofs/ tree + metadata.json) and the fonts (glyph files +
// one proofs file + metadata.json) — each under its own root directory CID,
// each servable by any static host or any range-capable IPFS gateway, and
// each written to a CAR for pinning. Fonts ship separately so one font
// package can serve any number of maps.
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, copyFile, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FontBundle } from '../src/font-bundle.js';
import { MapBundle } from '../src/map-bundle.js';
import { assembleFontBundle, assembleMapBundle, FONT_SET_PROVENANCE } from './lib/bundle.js';
import { writeCar } from './lib/dag-build.js';
import { directoryFetch } from './lib/local-fetch.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(repoRoot, 'data');
const outDir = join(repoRoot, 'build');
const distDir = join(repoRoot, 'dist');

async function main() {
  const mapPath = join(dataDir, 'map.pmtiles');
  const fileBytes = await readFile(mapPath);

  // 1. Assemble both packages (see scripts/lib/bundle.js).
  const map = await assembleMapBundle({ fileBytes });
  verifyLeafReassembly(map.leaves, map.blockstore, fileBytes);
  console.log(`${map.tileRanges.length} unique tile ranges; map CID ${map.mapEntry.cid}`);
  const proofBytes = map.proofTree.files.reduce((n, f) => n + f.content.length, 0);
  console.log(
    `proofs/: ${map.proofTree.shardCount} shards, ${map.proofTree.files.length} files, ${proofBytes} bytes`,
  );

  const fonts = await assembleFontBundle({
    fontsDir: join(dataDir, 'fonts'),
    provenance: FONT_SET_PROVENANCE,
  });
  console.log(`fonts: ${fonts.fontFiles.length} files, proofs ${fonts.proofsBytes.length} bytes`);

  // 2. One CAR per package (all blocks) — the IPFS-publication + pin
  // artifacts.
  await mkdir(outDir, { recursive: true });
  for (const [name, pkg] of [['map', map], ['fonts', fonts]]) {
    const carPath = join(outDir, `${name}.car`);
    await writeCarFile(pkg.root.cid, pkg.blockstore.blocks, carPath);
    console.log(`wrote ${relative(repoRoot, carPath)} (${pkg.blockstore.blocks.size} blocks)`);
  }

  // 3. Optional byte-identity check via Kubo (IPFS publication stays
  // possible, same root CIDs — but nothing in the serving path needs it).
  if (process.argv.includes('--pin')) {
    pinAndVerify(map.mapEntry.cid, mapPath);
  } else {
    console.log('skipping Kubo import (pass --pin to import + byte-verify)');
  }

  // 4. Assemble dist/ — a complete, self-contained static site: the page and
  // client code alongside the two data packages, each published under
  // ipfs/<rootCID>/ (exactly what `ipfs get <rootCID>` would produce; the
  // CID in the path is a legibility/interop convention, not a trust input).
  // This whole directory is what gets published (locally via `npm run
  // serve`, or by the Pages workflow).
  const mapDist = join(distDir, 'ipfs', map.root.cid.toString());
  const fontsDist = join(distDir, 'ipfs', fonts.root.cid.toString());
  await rm(distDir, { recursive: true, force: true });
  await assembleMapDist(mapDist, map, mapPath);
  await assembleFontDist(fontsDist, fonts);
  await assembleSite(distDir, map.root.cid.toString(), fonts.root.cid.toString());
  console.log(`assembled ${relative(repoRoot, distDir)}/ (page + client + map + fonts)`);

  // 5. Prove dist/ serves both packages through the real client resolvers
  // over an in-process dumb host — nothing but GET + Range.
  await verifyMapRoundTrip(mapDist, map, fileBytes);
  await verifyFontRoundTrip(fontsDist, fonts);
  console.log('dist/ round-trip: bootstrap + tiles + glyph byte-identical via the client');

  console.log(`MAP_ROOT_CID ${map.root.cid}`);
  console.log(`FONTS_ROOT_CID ${fonts.root.cid}`);
}

// Copy the page and client into dist/ next to the data packages, and assert
// index.html's inlined root CIDs match the freshly built ones — the drift
// guard that lets the demo carry its trust anchors inline instead of fetching
// a config file.
async function assembleSite(distDir, mapCid, fontsCid) {
  const indexHtml = await readFile(join(repoRoot, 'index.html'), 'utf8');
  for (const [label, cid] of [['map', mapCid], ['fonts', fontsCid]]) {
    if (!indexHtml.includes(cid)) {
      throw new Error(
        `index.html is missing the current ${label} root CID ${cid} — ` +
          `update the inlined config in index.html to match this build`,
      );
    }
  }
  await writeFile(join(distDir, 'index.html'), indexHtml);
  await cp(join(repoRoot, 'src'), join(distDir, 'src'), { recursive: true });
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

async function assembleFontDist(dir, fonts) {
  await mkdir(dir, { recursive: true });
  await cp(join(dataDir, 'fonts'), join(dir, 'fonts'), { recursive: true });
  await writeFile(join(dir, 'metadata.json'), fonts.metadataBytes);
  await writeFile(join(dir, 'proofs'), fonts.proofsBytes);
}

async function verifyMapRoundTrip(dir, map, fileBytes) {
  const bundle = await MapBundle.open(map.root.cid.toString(), [{ type: 'range', url: '.' }], {
    fetchFn: directoryFetch(dir),
  });
  const src = bundle.pmtilesSource();

  // pmtiles.js's first read spans leaves 0 + 1: exercises the multi-leaf run.
  const boot = await src.getBytes(0, 16384);
  assertBytesEqual(new Uint8Array(boot.data), fileBytes.subarray(0, 16384), 'bootstrap');

  const { tileRanges, header } = map;
  const samples = [0, 1, Math.floor(tileRanges.length / 2), tileRanges.length - 1];
  for (const i of samples) {
    const { offset, length } = tileRanges[i];
    const abs = header.tileDataOffset + offset;
    const got = await src.getBytes(abs, length);
    assertBytesEqual(new Uint8Array(got.data), fileBytes.subarray(abs, abs + length), `tile ${i}`);
  }
}

async function verifyFontRoundTrip(dir, fonts) {
  const bundle = await FontBundle.open(fonts.root.cid.toString(), [{ type: 'range', url: '.' }], {
    fetchFn: directoryFetch(dir),
  });
  const fontEntry = fonts.fontFiles[0];
  const rel = fontEntry.path.replace(/^fonts\//, '');
  const glyphUrl = `verified://${rel.split('/').map(encodeURIComponent).join('/')}`;
  const { data } = await bundle.protocolHandler()({ url: glyphUrl });
  assertBytesEqual(new Uint8Array(data), fontEntry.content, 'glyph');
}

function assertBytesEqual(a, b, label) {
  if (a.length !== b.length || Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) {
    throw new Error(`dist round-trip mismatch (${label}): ${a.length} vs ${b.length} bytes`);
  }
}

// In-memory equivalent of `ipfs cat | cmp`: concatenated leaf blocks must be
// byte-identical to the source file — and therefore so are the proof digests
// derived from their CIDs.
function verifyLeafReassembly(leaves, blockstore, fileBytes) {
  const raw = [...blockstore.blocks.values()].filter((b) => b.cid.code === 0x55);
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

function pinAndVerify(fileCid, mapPath) {
  for (const name of ['map', 'fonts']) {
    console.log(`importing ${name}.car into Kubo...`);
    execFileSync('ipfs', ['dag', 'import', join(outDir, `${name}.car`)], { stdio: 'inherit' });
  }
  console.log('verifying byte identity via ipfs cat...');
  execFileSync('sh', ['-c', `ipfs cat ${fileCid} | cmp - "${mapPath}"`], {
    stdio: 'inherit',
  });
  console.log('ipfs cat output is byte-identical to data/map.pmtiles');
}

await main();
