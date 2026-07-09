// End-to-end over the dumb host: scripts/serve.mjs serving dist/ (both
// packages), driving the real pmtiles.PMTiles through MapBundle and glyphs
// through FontBundle with nothing but GET + Range — no IPFS process
// anywhere. Asserts the request-shape budget (bootstrap = metadata.json +
// proofs meta + one shard + one range per package flow) and the
// "no gateway dependence" allowlist.
//
// Prereq: `node scripts/build.mjs` (assembles dist/). Not part of `npm test`.
// Usage: node test/integration-http.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PMTiles } from 'pmtiles';

import { parseArchive } from '../scripts/lib/pmtiles-parse.js';
import { serve } from '../scripts/serve.mjs';
import { FontBundle } from '../src/font-bundle.js';
import { MapBundle } from '../src/map-bundle.js';

const repo = new URL('..', import.meta.url);
const distDir = fileURLToPath(new URL('dist/', repo));
// The demo carries its root CIDs inline in index.html (no config.json); the
// build asserts they match the freshly built packages, so reading them here is
// equivalent to trusting the build.
const indexHtml = await readFile(new URL('index.html', repo), 'utf8');
const [mapCid, fontsCid] = [...indexHtml.matchAll(/anchor\('([a-z2-7]+)'\)/g)].map((m) => m[1]);
const fileBytes = await readFile(new URL('data/map.pmtiles', repo));

const server = await serve(distDir, 0);
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`dumb host serving dist/ at ${base}`);

try {
  // Record every fetched URL — the executable form of "no gateway dependence".
  const fetched = [];
  const fetchFn = (url, opts) => (fetched.push(url), fetch(url, opts));
  const mapRangesSince = (mark) =>
    fetched.slice(mark).filter((u) => u.endsWith('/map.pmtiles')).length;

  const bundle = await MapBundle.open(mapCid, [{ type: 'range', url: `${base}/ipfs/${mapCid}` }], {
    fetchFn,
  });
  assert.equal(fetched.length, 1, 'open fetches only metadata.json');
  assert.ok(fetched[0].endsWith('/metadata.json'));
  console.log('map bootstrap trust: metadata.json reconstructed the root CID');

  // Cold first read (pmtiles.js's header probe): the speculative range
  // fires in parallel with the proof descent but the probe is not
  // leaf-aligned, so it is discarded and the leaf-rounded run follows —
  // 2 range requests here buys 1-round-trip cold tile reads below.
  const src = bundle.pmtilesSource();
  let mark = fetched.length;
  const boot = await src.getBytes(0, 16384);
  assert.deepEqual(new Uint8Array(boot.data), new Uint8Array(fileBytes.subarray(0, 16384)));
  assert.equal(mapRangesSince(mark), 2, 'bootstrap = speculative probe + leaf-rounded run');
  assert.ok(fetched.slice(mark).some((u) => u.endsWith('/proofs/meta')));
  assert.equal(fetched.length, 5, 'cold start = metadata.json + meta + shard + 2 ranges');
  console.log('map cold start: 5 requests (metadata.json, proofs/meta, 1 shard, speculative + run)');

  const p = new PMTiles(bundle.pmtilesSource());
  const header = await p.getHeader();
  assert.equal(header.maxZoom, 6);
  console.log(`header via range source: zoom ${header.minZoom}-${header.maxZoom}`);

  const meta = await p.getMetadata();
  assert.ok(meta.name || meta.attribution);

  for (const [z, x, y] of [[0, 0, 0], [2, 2, 1], [4, 8, 5], [6, 33, 22], [6, 0, 0]]) {
    const tile = await p.getZxy(z, x, y);
    assert.ok(tile?.data?.byteLength > 0, `tile ${z}/${x}/${y}`);
    console.log(`tile ${z}/${x}/${y}: ${tile.data.byteLength} bytes (decompressed)`);
  }

  // The font package bootstraps independently, from its own root CID.
  mark = fetched.length;
  const fonts = await FontBundle.open(
    fontsCid,
    [{ type: 'range', url: `${base}/ipfs/${fontsCid}` }],
    { fetchFn },
  );
  assert.equal(fetched.length - mark, 1, 'font open fetches only metadata.json');
  console.log('font bootstrap trust: metadata.json reconstructed the root CID');

  const handler = fonts.protocolHandler();
  mark = fetched.length;
  const { data } = await handler({ url: 'verified://Noto%20Sans%20Regular/0-255.pbf' });
  const onDisk = await readFile(new URL('data/fonts/Noto Sans Regular/0-255.pbf', repo));
  assert.deepEqual(new Uint8Array(data), new Uint8Array(onDisk));
  assert.equal(fetched.length - mark, 2, 'first glyph = proofs table + glyph file');
  console.log(`glyph 0-255.pbf: byte-identical to data/ (${data.byteLength} bytes)`);

  mark = fetched.length;
  const second = await handler({ url: 'verified://Noto%20Sans%20Regular/256-511.pbf' });
  assert.ok(second.data.byteLength > 0);
  assert.equal(fetched.length - mark, 1, 'later glyphs cost one request each');

  const missing = await handler({ url: 'verified://Noto%20Sans%20Regular/999888-999999.pbf' });
  assert.equal(missing.data.byteLength, 0);

  // Sampled exact tile ranges byte-identical to the file. An uncached tile
  // costs exactly one map range request, plus at most one shard fetch the
  // first time its region of the proofs tree is touched.
  const { header: h, tileRanges } = parseArchive(fileBytes);
  for (const i of [0, 1, 500, 1500, tileRanges.length - 1]) {
    const { offset, length } = tileRanges[i];
    const abs = h.tileDataOffset + offset;
    mark = fetched.length;
    const got = await src.getBytes(abs, length);
    assert.deepEqual(
      new Uint8Array(got.data),
      new Uint8Array(fileBytes.subarray(abs, abs + length)),
      `tile range ${i}`,
    );
    if (i >= 500) {
      assert.equal(mapRangesSince(mark), 1, `uncached tile ${i} is one range request`);
      assert.ok(fetched.length - mark <= 2, `tile ${i}: at most one extra proof fetch`);
    }
  }
  console.log('sampled tile ranges: byte-identical, one range request per uncached tile');

  // Both shards are on the host; a deep-zoom tile must have pulled the second.
  assert.ok(
    fetched.some((u) => /\/proofs\/[0-9a-f]{16}$/.test(u) && !u.endsWith('/0000000000000000')),
    'the tail shard was fetched lazily',
  );

  // No gateway dependence: every URL stays under the configured bases (the
  // dumb host's ipfs/<rootCID>/ directories — the path names the CID but
  // nothing resolves it), and none uses a gateway API shape.
  for (const url of fetched) {
    assert.ok(
      url.startsWith(`${base}/ipfs/${mapCid}/`) || url.startsWith(`${base}/ipfs/${fontsCid}/`),
      `off-base fetch: ${url}`,
    );
    assert.doesNotMatch(url, /format=raw|\?/, `gateway-shaped fetch: ${url}`);
  }
  console.log(`every one of ${fetched.length} fetches stayed under the bases (zero gateway traffic)`);

  console.log('stats:', JSON.stringify({ map: bundle.stats, fonts: fonts.stats }));
  console.log('OK');
} finally {
  server.close();
}
