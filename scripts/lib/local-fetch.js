// A fetch() over a local directory that honours single `Range` requests —
// the in-process "dumb host" the build uses to self-check that `dist/` is
// fully reassemblable through the real client resolver. Trusted inputs only
// (build/tests); the shipping dev server (scripts/serve.mjs) guards traversal.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function directoryFetch(dir) {
  return async (url, { headers, signal } = {}) => {
    signal?.throwIfAborted();
    const rel = new URL(url, 'http://host/').pathname.replace(/^\/+/, '');
    const segments = rel.split('/').map(decodeURIComponent);
    let bytes;
    try {
      bytes = await readFile(join(dir, ...segments));
    } catch {
      return new Response('not found', { status: 404 });
    }
    const range = parseRange(headers);
    if (!range) return new Response(new Uint8Array(bytes), { status: 200 });
    const end = Math.min(range.end + 1, bytes.length);
    return new Response(new Uint8Array(bytes.subarray(range.start, end)), {
      status: 206,
      headers: { 'Content-Range': `bytes ${range.start}-${end - 1}/${bytes.length}` },
    });
  };
}

function parseRange(headers) {
  const value = headers?.Range ?? headers?.range;
  const match = value && /^bytes=(\d+)-(\d+)$/.exec(value);
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null;
}
