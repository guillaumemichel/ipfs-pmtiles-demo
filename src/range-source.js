// Byte source for one base URL of a published bundle — a dumb static host or
// an /ipfs/<rootCID>/ path on any range-capable HTTP gateway; the client
// cannot tell the difference. Two request shapes only: a plain GET for whole
// small files (metadata.json, proofs, fonts — CORS simple requests in every
// browser) and a single-`Range` GET for map byte runs. Returns UNVERIFIED
// bytes; the VerifiedStore above is the one verification choke point.
import { readBody } from './read-body.js';

// A ranged GET the host answered with 200 (whole file) instead of 206: it
// ignores Range, so a per-tile read would drag the entire archive.
export class RangeUnsupportedError extends Error {
  name = 'RangeUnsupportedError';
}

// A ranged GET rejected with a network TypeError even though a plain GET to
// the same base already succeeded (metadata.json always has by then) — the
// signature of a CORS preflight the host cannot answer (Firefox + a host
// that cannot allow `Range`).
export class RangeBlockedError extends Error {
  name = 'RangeBlockedError';
}

export class RangeSource {
  #base;
  #fetchFn;
  #plainGetOk = false;

  constructor(base, { fetchFn } = {}) {
    this.#base = base.replace(/\/$/, '');
    this.#fetchFn = fetchFn ?? ((...args) => fetch(...args));
  }

  // Whole file by decoded UnixFS path; body read with a hard cap.
  async fetchWhole(path, cap, { signal } = {}) {
    const res = await this.#request(this.#url(path), { signal }, true);
    const body = await readBody(res, cap);
    this.#plainGetOk = true;
    return body;
  }

  // One contiguous byte range of a published file. Demands 206: a 200 means
  // the host ignored Range and would stream the whole archive per tile.
  async fetchRange(path, start, length, { signal } = {}) {
    const init = { signal, headers: { Range: `bytes=${start}-${start + length - 1}` } };
    const res = await this.#request(this.#url(path), init, false);
    return readBody(res, length);
  }

  #url(path) {
    return `${this.#base}/${encodePath(path)}`;
  }

  async #request(url, init, plainGet) {
    let res;
    try {
      res = await this.#fetchFn(url, init);
    } catch (err) {
      if (!plainGet && this.#plainGetOk && err instanceof TypeError) {
        throw new RangeBlockedError(
          `${url}: host refuses cross-origin range requests in this browser`,
        );
      }
      throw err;
    }
    if (!res.ok) {
      res.body?.cancel?.();
      throw new Error(`${url}: HTTP ${res.status}`);
    }
    if (!plainGet && res.status !== 206) {
      res.body?.cancel?.();
      throw new RangeUnsupportedError(
        `${url}: host ignored Range (status ${res.status}, wanted 206)`,
      );
    }
    return res;
  }
}

// Percent-encode each path segment (paths contain a space: "Noto Sans
// Regular"); the separators stay literal.
export function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

// Source list from a config spec: [{ type: 'range', url }]. fetchFn is the
// test / tamper seam shared by every source.
export function makeSources(specs, fetchFn) {
  return specs.map((spec) => {
    if (spec.type !== 'range') throw new Error(`unknown source type: ${spec.type}`);
    return new RangeSource(spec.url, { fetchFn });
  });
}
