// Shared test fixtures: deterministic bytes, an in-memory "dumb host"
// (plain GET + single Range), and miniature map/font packages assembled
// with the real build pipeline.
import { assembleFontDag, assembleMapDag } from '../scripts/lib/bundle.js';

// xorshift32-based deterministic bytes so fixtures never depend on RNG state.
export function deterministicBytes(length, seed = 42) {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

// fetchFn for a dumb static host: `files` maps decoded UnixFS paths (e.g.
// 'map.pmtiles', 'proofs/meta', 'fonts/Noto Sans Regular/0-255.pbf') to
// bytes. Answers a single `Range: bytes=a-b` with 206, everything else with
// 200. tamper(path, range, bytes) may replace the response body — `range` is
// null for a plain GET, so a test can corrupt only ranged (tile) responses.
export function rangeFetch(files, { tamper, onRequest } = {}) {
  return async (url, { headers, signal } = {}) => {
    signal?.throwIfAborted();
    onRequest?.(url, headers);
    const rel = new URL(url, 'http://host/').pathname.replace(/^\/+/, '');
    const path = rel.split('/').map(decodeURIComponent).join('/');
    const bytes = files.get(path);
    if (bytes === undefined) return new Response('not found', { status: 404 });

    const value = headers?.Range ?? headers?.range;
    const match = value && /^bytes=(\d+)-(\d+)$/.exec(value);
    if (!match) {
      const body = tamper ? (tamper(path, null, bytes) ?? bytes) : bytes;
      return new Response(new Uint8Array(body), { status: 200 });
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]) + 1, bytes.length);
    const range = { start, end };
    let slice = bytes.subarray(start, end);
    if (tamper) slice = tamper(path, range, slice) ?? slice;
    return new Response(new Uint8Array(slice), { status: 206 });
  };
}

// A miniature map package assembled with the real pipeline, plus the file
// map a dumb host would serve after `ipfs get <rootCID>`.
export async function testMapBundle({ mapBytes, cuts, shardCap, metaMaxEntries } = {}) {
  const dag = await assembleMapDag({
    mapBytes,
    cuts,
    provenance: { source: { build: 'test' } },
    shardCap,
    metaMaxEntries,
  });
  const files = new Map([
    ['map.pmtiles', mapBytes],
    ['metadata.json', dag.metadataBytes],
    ...dag.proofTree.files.map((f) => [`proofs/${f.path}`, f.content]),
  ]);
  return { rootCid: dag.root.cid.toString(), files, dag };
}

export const DEFAULT_FONTS = [
  { path: 'fonts/Noto Sans Regular/0-255.pbf', content: deterministicBytes(150, 31) },
];

// A miniature font package, same shape.
export async function testFontBundle({ fonts = DEFAULT_FONTS } = {}) {
  const dag = await assembleFontDag({
    fontFiles: fonts,
    provenance: { source: { build: 'test' } },
  });
  const files = new Map([
    ['metadata.json', dag.metadataBytes],
    ['proofs', dag.proofsBytes],
    ...fonts.map((f) => [f.path, f.content]),
  ]);
  return { rootCid: dag.root.cid.toString(), files, dag };
}

export function flipByte(bytes, index = 0) {
  const copy = new Uint8Array(bytes);
  copy[index] ^= 0xff;
  return copy;
}
