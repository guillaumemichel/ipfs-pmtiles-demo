// End-to-end verification against the deployable static site. It records all
// requests to ensure archives use exact ranges while proof and asset files use
// whole-file GETs only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PMTiles, zxyToTileId } from 'pmtiles';
import { NotFoundError, VerifiedAsset, VerifiedSource } from 'veritiles';

import { parseArchive } from '../scripts/lib/pmtiles-parse.js';
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
const fetched = [];
const fetchFn = (url, opts) => {
  fetched.push({ url: String(url), range: opts?.headers?.Range });
  return fetch(url, opts);
};

try {
  const mapSource = new VerifiedSource({ cid: mapCid, source: `${base}/map.pmtiles`, fetchFn });
  const map = new PMTiles(mapSource);
  assert.equal((await map.getHeader()).maxZoom, 6);
  for (const coordinate of [[0, 0, 0], [2, 2, 1], [4, 8, 5], [6, 33, 22]]) {
    assert.ok((await map.getZxy(...coordinate))?.data?.byteLength > 0, `map tile ${coordinate.join('/')}`);
  }
  assert.deepEqual(
    new Uint8Array((await mapSource.getBytes(0, 16384)).data),
    new Uint8Array(mapBytes.subarray(0, 16384)),
  );

  const elevationSource = new VerifiedSource({
    cid: elevationCid, source: `${base}/elevation.pmtiles`, fetchFn,
  });
  const elevation = new PMTiles(elevationSource);
  assert.equal((await elevation.getHeader()).maxZoom, 4);
  assert.ok((await elevation.getZxy(0, 0, 0))?.data?.byteLength > 0);
  const archive = parseArchive(elevationBytes);
  const present = new Set(archive.entries.flatMap((entry) =>
    Array.from({ length: entry.runLength }, (_, index) => entry.tileId + index),
  ));
  const absent = [4, 0, 0];
  if (!present.has(zxyToTileId(...absent))) assert.equal(await elevation.getZxy(...absent), undefined);

  const style = new VerifiedAsset({ cid: styleCid, source: `${base}/assets/style.json`, fetchFn });
  const styleJson = JSON.parse(new TextDecoder().decode(await style.bytes()));
  assert.equal(styleJson.sources['pmtiles-source'].url, `pmtiles://${mapCid}`);
  assert.equal(styleJson.glyphs, `verified://${fontsCid}/{fontstack}/{range}.pbf`);

  const fonts = new VerifiedAsset({ cid: fontsCid, source: `${base}/assets/fonts`, fetchFn });
  const glyph = await fonts.bytes('Noto Sans Regular/0-255.pbf');
  assert.deepEqual(
    glyph,
    new Uint8Array(await readFile(new URL('fonts/Noto Sans Regular/0-255.pbf', dataDir))),
  );
  await assert.rejects(fonts.bytes('Noto Sans Regular/absent.pbf'), NotFoundError);

  for (const request of fetched) {
    if (request.url.includes('.proofs/') || request.url.includes('/assets/')) {
      assert.equal(request.range, undefined, `asset/proof used Range: ${request.url}`);
    }
    assert.ok(request.url.startsWith(base), `unexpected host: ${request.url}`);
  }
  assert.ok(fetched.some(({ url }) => url.endsWith('/map.pmtiles.proofs/root')));
  assert.ok(fetched.some(({ url }) => url.endsWith('/elevation.pmtiles.proofs/root')));
  assert.ok(fetched.some(({ url }) => url.endsWith('/assets/fonts.car')));
  assert.ok(fetched.some(({ url }) => url.endsWith('/assets/style.json')));
  assert.ok(fetched.some(({ url, range }) => url.endsWith('.pmtiles') && range));
  console.log(`verified ${fetched.length} fetched resources: map/elevation tiles and proofs, style, font proof, and glyph`);
} finally {
  server.close();
}
