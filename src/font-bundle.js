// A verified font package — fonts ship separately from maps so one font
// package can serve any number of maps. Same trust model and machinery as
// the map package (metadata.json → root CID reconstruction, digest-verified
// whole-file fetches through the shared store); the only format difference
// is the proofs shape: one flat `proofs` file mapping font paths to digests,
// no range requests anywhere.
import { openFontManifest } from './bootstrap.js';
import { decodeFontProofs } from './proof-format.js';
import { makeSources } from './range-source.js';
import { VerifiedStore } from './verified-store.js';

// Every font-package file is a single raw leaf by build rule (< 256 KiB), so
// whole-file reads are capped there and each file hashes to its child CID.
const FONT_FILE_CAP = 256 * 1024;

export class FontBundle {
  #manifest;
  #store;
  #table; // Promise<Map(path -> digest)> | undefined, lazy

  constructor(manifest, store) {
    this.#manifest = manifest;
    this.#store = store;
  }

  // sources: [{ type: 'range', url }] — plain GETs only; range support is
  // never exercised. opts.fetchFn is the test / tamper seam.
  static async open(rootCid, sources, opts = {}) {
    const store = new VerifiedStore(makeSources(sources, opts.fetchFn), opts);
    const manifest = await openFontManifest(rootCid, store);
    return new FontBundle(manifest, store);
  }

  get stats() {
    return this.#store.stats;
  }

  // MapLibre addProtocol handler: verified://{fontstack}/{range}.pbf. Glyph
  // digests come from the proofs table (fetched once, verified against the
  // manifest); absent ranges resolve to an empty response (MapLibre
  // tolerates missing ranges); verification failures reject.
  protocolHandler() {
    return async (params, abortController) => {
      const signal = abortController?.signal;
      // MapLibre URL-encodes path segments (Noto%20Sans%20Regular).
      const path = params.url
        .replace(/^verified:\/\//, '')
        .split('/')
        .map(decodeURIComponent)
        .join('/');
      const table = await this.#proofsTable(signal);
      const digest = table.get(path);
      if (digest === undefined) return { data: new ArrayBuffer(0) };
      const bytes = await this.#store.fetchWhole(
        `${this.#manifest.fontsDir}/${path}`,
        digest,
        FONT_FILE_CAP,
        { signal },
      );
      return { data: toArrayBuffer(bytes) };
    };
  }

  #proofsTable(signal) {
    // Do not cache failures: a flaky first fetch must stay retryable.
    if (this.#table === undefined) {
      this.#table = (async () => {
        const bytes = await this.#store.fetchWhole(
          this.#manifest.proofsFile,
          this.#manifest.proofsDigest,
          FONT_FILE_CAP,
          { signal },
        );
        return decodeFontProofs(bytes);
      })();
      this.#table.catch(() => {
        this.#table = undefined;
      });
    }
    return this.#table;
  }
}

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
