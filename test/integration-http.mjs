// End-to-end verification against the deployable static site, configured the
// way the page is: anchors only, every location resolved through hints.json.
// It records all requests to ensure archives use exact ranges while the hints
// documents, proofs, and assets use whole-file GETs only, and that glyph bytes
// come from the published files rather than from raw sections in the proof.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PMTiles, zxyToTileId } from 'pmtiles';
import { NotFoundError, VerifiedAsset, VerifiedSource } from 'veritiles';

import { parseArchive } from '../scripts/lib/pmtiles-parse.js';
import { carBlockCount } from '../scripts/lib/thin-car.js';
import { serve } from '../scripts/serve.mjs';

const repo = new URL('..', import.meta.url);
const distDir = fileURLToPath(new URL('dist/', repo));
const dataDir = new URL('data/', repo);
const page = await readFile(new URL('index.html', new URL('dist/', repo)), 'utf8');
const cidFor = (key) => page.match(new RegExp(`${key}:\\s*'([a-z2-7]+)'`))[1];
const mapCid = cidFor('map');
const elevationCid = cidFor('elevation');
const fontsCid = cidFor('fonts');
const styleCid = cidFor('style');
const mapBytes = await readFile(new URL('map.pmtiles', dataDir));
const elevationBytes = await readFile(new URL('elevation.pmtiles', dataDir));

const server = await serve(distDir, 0);
const base = `http://127.0.0.1:${server.address().port}`;
// The page relies on the client's `./hints.json` default; Node has no document
// base URL to resolve that against, so name the same file outright.
const hints = `${base}/hints.json`;
const fetched = [];
const fetchFn = (url, opts) => {
  fetched.push({ url: String(url), range: opts?.headers?.Range });
  return fetch(url, opts);
};

try {
  const mapSource = new VerifiedSource({ cid: mapCid, hints, fetchFn });
  const map = new PMTiles(mapSource);
  assert.equal((await map.getHeader()).maxZoom, 6);
  for (const coordinate of [[0, 0, 0], [2, 2, 1], [4, 8, 5], [6, 33, 22]]) {
    assert.ok((await map.getZxy(...coordinate))?.data?.byteLength > 0, `map tile ${coordinate.join('/')}`);
  }
  assert.deepEqual(
    new Uint8Array((await mapSource.getBytes(0, 16384)).data),
    new Uint8Array(mapBytes.subarray(0, 16384)),
  );

  const elevationSource = new VerifiedSource({ cid: elevationCid, hints, fetchFn });
  const elevation = new PMTiles(elevationSource);
  assert.equal((await elevation.getHeader()).maxZoom, 4);
  assert.ok((await elevation.getZxy(0, 0, 0))?.data?.byteLength > 0);
  const archive = parseArchive(elevationBytes);
  const present = new Set(archive.entries.flatMap((entry) =>
    Array.from({ length: entry.runLength }, (_, index) => entry.tileId + index),
  ));
  const absent = [4, 0, 0];
  if (!present.has(zxyToTileId(...absent))) assert.equal(await elevation.getZxy(...absent), undefined);

  const style = new VerifiedAsset({ cid: styleCid, hints, fetchFn });
  const styleJson = JSON.parse(new TextDecoder().decode(await style.bytes()));
  assert.equal(styleJson.sources['pmtiles-source'].url, `pmtiles://${mapCid}`);
  assert.equal(styleJson.glyphs, `verified://${fontsCid}/{fontstack}/{range}.pbf`);

  // The bundle proof is the manifest and nothing else, so each glyph is a
  // separate lazy GET of a published file rather than a slice of a 6 MB bag.
  const carBytes = new Uint8Array(await (await fetch(`${base}/assets/fonts.car`)).arrayBuffer());
  assert.equal(await carBlockCount(carBytes), 1, 'fonts.car must carry only the manifest block');
  assert.ok(carBytes.length < 64 * 1024, `fonts.car is ${carBytes.length} B; the proof should be tiny`);

  const fonts = new VerifiedAsset({ cid: fontsCid, hints, fetchFn });
  const glyph = await fonts.bytes('Noto Sans Regular/0-255.pbf');
  assert.deepEqual(
    glyph,
    new Uint8Array(await readFile(new URL('fonts/Noto Sans Regular/0-255.pbf', dataDir))),
  );
  await assert.rejects(fonts.bytes('Noto Sans Regular/absent.pbf'), NotFoundError);

  for (const request of fetched) {
    if (!request.url.endsWith('.pmtiles')) {
      assert.equal(request.range, undefined, `non-archive read used Range: ${request.url}`);
    }
    assert.ok(request.url.startsWith(base), `unexpected host: ${request.url}`);
  }
  assert.ok(fetched.some(({ url }) => url === hints), 'hints.json was never consulted');
  assert.ok(fetched.some(({ url }) => url.endsWith('/map.pmtiles.proofs/root')));
  assert.ok(fetched.some(({ url }) => url.endsWith('/elevation.pmtiles.proofs/root')));
  assert.ok(fetched.some(({ url }) => url.endsWith('/assets/fonts.car')));
  assert.ok(fetched.some(({ url }) => url.endsWith('/assets/style.json')));
  assert.ok(fetched.some(({ url, range }) => url.endsWith('.pmtiles') && range));
  // The page never names the glyph document: the client finds it by probing the
  // directory that holds the proof CAR (veritiles SPEC.md §5 Discovery).
  assert.ok(
    fetched.some(({ url }) => url === `${base}/assets/hints.json`),
    'the glyph hints document was never discovered',
  );
  assert.ok(fetched.some(({ url }) => url.endsWith('.pbf')), 'no glyph file was fetched');

  // A tampered glyph must be caught, not rendered — the check that was dead
  // while every glyph came pre-inlined in the proof.
  const tamperFetch = async (url, opts) => {
    const res = await fetch(url, opts);
    if (!String(url).endsWith('.pbf') || !res.ok) return res;
    const bytes = new Uint8Array(await res.arrayBuffer());
    bytes[0] ^= 0xff;
    return new Response(bytes, { status: 200 });
  };
  const tampered = new VerifiedAsset({ cid: fontsCid, hints, fetchFn: tamperFetch });
  await assert.rejects(tampered.bytes('Noto Sans Regular/0-255.pbf'));
  assert.equal(tampered.stats.rejected, 1, 'a tampered glyph must count one rejection');

  console.log(`verified ${fetched.length} fetched resources, all located by hints documents: ` +
    `map/elevation tiles and proofs, style, a ${carBytes.length} B bundle proof, and a glyph file`);
} finally {
  server.close();
}
