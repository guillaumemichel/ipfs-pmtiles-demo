#!/usr/bin/env node
// The "dumb host": a static file server with single-`Range` 206 support and
// nothing else — no IPFS, no gateway semantics. Serves the repo root by
// default so `index.html` and the `dist/` bundle load same-origin; point it
// at `dist/` for the integration test. CORS is opened (`*` + a `Range`
// preflight answer) so cross-origin embedding works from Chromium; Firefox's
// range preflight is answered too, though its own single-range safelist gap
// remains an accepted limitation.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // Binary payloads: octet-stream avoids any transparent transcoding that
  // would corrupt ranged slices (design host contract).
  '.pmtiles': 'application/octet-stream',
  '.car': 'application/octet-stream',
  '.pbf': 'application/octet-stream',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Max-Age': '86400',
};

// Returns the running http.Server; caller closes it. port 0 picks a free port.
export function serve(root, port = 0) {
  const rootDir = resolve(root);
  const server = createServer((req, res) => handle(rootDir, req, res));
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res(server)));
}

async function handle(rootDir, req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, CORS);
    res.end();
    return;
  }

  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://host').pathname);
  } catch {
    res.writeHead(400, CORS);
    res.end('bad request');
    return;
  }
  let path = safeJoin(rootDir, rel);
  if (path === null) {
    res.writeHead(403, CORS);
    res.end('forbidden');
    return;
  }

  let info;
  try {
    info = await stat(path);
    if (info.isDirectory()) {
      path = join(path, 'index.html');
      info = await stat(path);
    }
  } catch {
    res.writeHead(404, CORS);
    res.end('not found');
    return;
  }

  const headers = { ...CORS, 'Content-Type': contentType(path), 'Accept-Ranges': 'bytes' };
  const range = parseRange(req.headers.range, info.size);
  if (req.headers.range && range === null) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` });
    res.end();
    return;
  }
  if (!range) {
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(path).pipe(res);
    return;
  }

  res.writeHead(206, {
    ...headers,
    'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
    'Content-Length': range.end - range.start + 1,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(path, { start: range.start, end: range.end }).pipe(res);
}

function safeJoin(rootDir, rel) {
  const path = normalize(join(rootDir, rel));
  return path === rootDir || path.startsWith(rootDir + '/') ? path : null;
}

function contentType(path) {
  return TYPES[extname(path)] ?? 'application/octet-stream';
}

// Single range only: `bytes=a-b` or `bytes=a-`. Multi-range is unsupported
// (the client never sends it; neither does S3).
function parseRange(header, size) {
  const match = header && /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Number(match[2]);
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

// CLI: node scripts/serve.mjs [dir] [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? '.';
  const port = Number(process.argv[3] ?? 8080);
  const server = await serve(dir, port);
  const { port: actual } = server.address();
  console.log(`serving ${resolve(dir)} at http://127.0.0.1:${actual}/`);
}
