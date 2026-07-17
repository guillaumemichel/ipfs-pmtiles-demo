// End-to-end over the dumb host: scripts/serve.mjs serving dist/ (both
// range-verified packages and both verified assets), driving the real
// pmtiles.PMTiles through veritiles' VerifiedSource (map + elevation) and the
// style + glyphs through VerifiedAsset — nothing but GET + Range, no IPFS
// process anywhere. Asserts byte-identity, the asset invariants (assets are
// whole-file GETs with NO Range header, the proof is fetched once), a tampered
// glyph rejects, and the "no gateway dependence" allowlist.
//
// Prereq: `node scripts/build.mjs` (assembles dist/). Not part of `npm test`.
// Usage: node test/integration-http.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PMTiles, zxyToTileId } from 'pmtiles';
import { NotFoundError, VerifiedAsset, VerifiedSource } from 'veritiles';

import { parseArchive } from '../scripts/lib/pmtiles-parse.js';
import { serve } from '../scripts/serve.mjs';

const repo = new URL('..', import.meta.url);
const distDir = fileURLToPath(new URL('dist/', repo));
// The demo carries its five CIDs inline in index.html (no config.json); the
// build asserts they match the freshly built artifacts, so reading them here is
// equivalent to trusting the build.
const indexHtml = await readFile(new URL('index.html', repo), 'utf8');
const cidFor = (key) => indexHtml.match(new RegExp(`${key}:\\s*'([a-z2-7]+)'`))[1];
const mapCid = cidFor('map');
const elevationCid = cidFor('elevation');
const fontsRoot = cidFor('fontsRoot');
const fontsAnchor = cidFor('fontsAnchor');
const styleCid = cidFor('style');
const fileBytes = await readFile(new URL('data/map.pmtiles', repo));
const elevationBytes = await readFile(new URL('data/elevation.pmtiles', repo));

const server = await serve(distDir, 0);
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`dumb host serving dist/ at ${base}`);

try {
  // Record every fetched URL and whether it carried a Range header — the
  // executable form of "no gateway dependence" and "assets are simple GETs".
  const fetched = [];
  const fetchFn = (url, opts) => {
    fetched.push({ url, range: opts?.headers?.Range });
    return fetch(url, opts);
  };
  const at = (mark) => fetched.slice(mark).map((r) => r.url);

  // --- Map: a range-verified package read through VerifiedSource. ---
  const mapSource = new VerifiedSource({ rootCid: mapCid, source: `${base}/ipfs/${mapCid}`, fetchFn });
  const boot = await mapSource.getBytes(0, 16384);
  assert.deepEqual(new Uint8Array(boot.data), new Uint8Array(fileBytes.subarray(0, 16384)));
  console.log('map bootstrap: metadata.json reconstructed the root; first 16 KiB byte-identical');

  const p = new PMTiles(mapSource);
  const header = await p.getHeader();
  assert.equal(header.maxZoom, 6);
  const meta = await p.getMetadata();
  assert.ok(meta.name || meta.attribution);
  for (const [z, x, y] of [[0, 0, 0], [2, 2, 1], [4, 8, 5], [6, 33, 22]]) {
    const tile = await p.getZxy(z, x, y);
    assert.ok(tile?.data?.byteLength > 0, `tile ${z}/${x}/${y}`);
  }
  console.log(`map: header zoom ${header.minZoom}-${header.maxZoom}; sampled tiles decode`);

  // Sampled exact tile ranges byte-identical to the source file.
  const { header: h, tileRanges } = parseArchive(fileBytes);
  for (const i of [0, 1, 500, 1500, tileRanges.length - 1]) {
    const { offset, length } = tileRanges[i];
    const abs = h.tileDataOffset + offset;
    const got = await mapSource.getBytes(abs, length);
    assert.deepEqual(
      new Uint8Array(got.data),
      new Uint8Array(fileBytes.subarray(abs, abs + length)),
      `tile range ${i}`,
    );
  }
  console.log('map: sampled tile ranges byte-identical');

  // --- Style: a verified raw asset (whole-file GET, no proof). ---
  const styleAsset = new VerifiedAsset({ cid: styleCid, source: `${base}/ipfs/${styleCid}`, fetchFn });
  const style = JSON.parse(new TextDecoder().decode(await styleAsset.bytes('')));
  assert.equal(style.sources['pmtiles-source'].url, `pmtiles://${mapCid}`);
  assert.equal(style.glyphs, `verified://${fontsAnchor}/{fontstack}/{range}.pbf`);
  assert.equal(style.sources.terrainSource.maxzoom, 4);
  console.log('style: verified raw asset parses; pmtiles/verified/maxzoom baked from the build');

  // --- Fonts: a verified directory asset anchored by its CAR proof. ---
  const fonts = new VerifiedAsset({ cid: fontsAnchor, source: `${base}/ipfs/${fontsRoot}`, fetchFn });
  let mark = fetched.length;
  const glyph = await fonts.bytes('Noto Sans Regular/0-255.pbf');
  const onDisk = await readFile(new URL('data/fonts/Noto Sans Regular/0-255.pbf', repo));
  assert.deepEqual(new Uint8Array(glyph), new Uint8Array(onDisk));
  assert.ok(at(mark).some((u) => u.endsWith(`/ipfs/${fontsRoot}.car`)), 'first glyph loads the proof');
  console.log(`glyph 0-255.pbf: byte-identical to data/ (${glyph.byteLength} bytes)`);

  mark = fetched.length;
  const second = await fonts.bytes('Noto Sans Regular/256-511.pbf');
  assert.ok(second.byteLength > 0);
  assert.equal(at(mark).filter((u) => u.endsWith('.car')).length, 0, 'proof fetched once across two glyphs');
  console.log('glyph 256-511.pbf: served without re-fetching the proof');

  // A glyph range the artifact does not contain is an authenticated absence.
  await assert.rejects(fonts.bytes('Noto Sans Regular/absent.pbf'), NotFoundError);
  console.log('absent glyph: NotFoundError (authenticated absence)');

  // Every asset request (style body, glyph, proof) is a whole-file GET — no
  // Range header, a CORS simple request (veritiles SPEC.md A3).
  for (const { url, range } of fetched) {
    if (url.endsWith('.pbf') || url.endsWith('.car') || url.endsWith(`/ipfs/${styleCid}`)) {
      assert.equal(range, undefined, `asset request carried a Range header: ${url}`);
    }
  }
  console.log('assets: every style/glyph/proof request was a whole-file GET (no Range)');

  // --- Elevation: the same VerifiedSource, its own root CID. ---
  const elevationSource = new VerifiedSource({
    rootCid: elevationCid,
    source: `${base}/ipfs/${elevationCid}`,
    fetchFn,
  });
  const dem = new PMTiles(elevationSource);
  const demHeader = await dem.getHeader();
  assert.equal(demHeader.maxZoom, 4);
  assert.equal(demHeader.tileType, 4); // webp
  const demTile = await dem.getZxy(0, 0, 0);
  assert.ok(demTile?.data?.byteLength > 0, 'elevation tile 0/0/0');
  const demArchive = parseArchive(elevationBytes);
  const rootEntry = demArchive.entries.find((e) => e.tileId === 0 && e.runLength > 0);
  const rootAbs = demArchive.header.tileDataOffset + rootEntry.offset;
  assert.deepEqual(
    new Uint8Array(demTile.data),
    new Uint8Array(elevationBytes.subarray(rootAbs, rootAbs + rootEntry.length)),
    'elevation tile 0/0/0 byte-identical',
  );

  // A tile absent from the archive (pure-ocean region) resolves to undefined.
  const present = new Set(
    demArchive.entries.flatMap((e) => Array.from({ length: e.runLength }, (_, i) => e.tileId + i)),
  );
  let hole;
  for (let x = 0; x < 16 && hole === undefined; x++) {
    for (let y = 0; y < 16 && hole === undefined; y++) {
      if (!present.has(zxyToTileId(4, x, y))) hole = [4, x, y];
    }
  }
  assert.ok(hole, 'expected at least one absent z4 elevation tile');
  assert.equal(await dem.getZxy(...hole), undefined);
  console.log(`elevation: tile 0/0/0 byte-identical; missing tile ${hole.join('/')} resolves to undefined`);

  // --- A tampered glyph rejects (never renders). ---
  const tamperFetch = async (url, opts) => {
    const res = await fetch(url, opts);
    if (!res.ok || !url.endsWith('.pbf')) return res;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > 0) bytes[0] ^= 0xff;
    return new Response(bytes, { status: res.status });
  };
  const tampered = new VerifiedAsset({
    cid: fontsAnchor,
    source: `${base}/ipfs/${fontsRoot}`,
    fetchFn: tamperFetch,
  });
  await assert.rejects(tampered.bytes('Noto Sans Regular/0-255.pbf'));
  assert.ok(tampered.stats.rejected >= 1, 'tampered glyph counted a rejection');
  console.log('tampered glyph: rejected against the proof, never returned');

  // No gateway dependence: every URL stays under a configured base (the dumb
  // host's ipfs/<id> paths — the id names the CID but nothing resolves it), and
  // none uses a gateway API shape.
  const bases = [
    `${base}/ipfs/${mapCid}/`,
    `${base}/ipfs/${elevationCid}/`,
    `${base}/ipfs/${fontsRoot}/`,
    `${base}/ipfs/${fontsRoot}.car`,
    `${base}/ipfs/${styleCid}`,
  ];
  for (const { url } of fetched) {
    assert.ok(bases.some((b) => url === b || url.startsWith(b)), `off-base fetch: ${url}`);
    assert.doesNotMatch(url, /format=raw|\?/, `gateway-shaped fetch: ${url}`);
  }
  console.log(`every one of ${fetched.length} fetches stayed under the bases (zero gateway traffic)`);

  console.log(
    'stats:',
    JSON.stringify({
      map: mapSource.stats,
      elevation: elevationSource.stats,
      fonts: fonts.stats,
      style: styleAsset.stats,
    }),
  );
  console.log('OK');
} finally {
  server.close();
}
