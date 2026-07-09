// A verified map package: bootstrap (metadata.json → root CID
// reconstruction) plus a pmtiles.Source over the map file, anchored to one
// root CID over a configured list of dumb byte sources (static hosts or
// /ipfs/<rootCID>/ gateway paths; the client treats them identically).
import { openMapManifest } from './bootstrap.js';
import { MapFile } from './map-file.js';
import { ProofIndex } from './proof-index.js';
import { makeSources } from './range-source.js';
import { VerifiedStore } from './verified-store.js';

export class MapBundle {
  #rootCid;
  #map;
  #store;

  constructor(rootCid, manifest, store) {
    this.#rootCid = rootCid;
    this.#store = store;
    const proofs = new ProofIndex(store, {
      dir: manifest.proofsDir,
      metaDigest: manifest.proofsMetaDigest,
      fileSize: manifest.mapSize,
    });
    this.#map = new MapFile(store, proofs, manifest.mapFile, manifest.mapSize);
  }

  // sources: [{ type: 'range', url }]. opts.fetchFn is the test / tamper
  // seam; opts.maxCacheBytes bounds the LRU.
  static async open(rootCid, sources, opts = {}) {
    const store = new VerifiedStore(makeSources(sources, opts.fetchFn), opts);
    const manifest = await openMapManifest(rootCid, store);
    return new MapBundle(rootCid, manifest, store);
  }

  get stats() {
    return this.#store.stats;
  }

  // pmtiles.Source implementation over the package's map file.
  pmtilesSource() {
    const key = this.#rootCid;
    return {
      getKey: () => key,
      getBytes: async (offset, length, signal) => {
        // read() returns a freshly allocated, unshared, exactly-sized buffer,
        // so hand pmtiles its ArrayBuffer directly — no defensive copy (unlike
        // FontBundle, which must copy because fetchWhole returns the cached
        // reference).
        const bytes = await this.#map.read(offset, length, { signal });
        return { data: bytes.buffer };
      },
    };
  }
}
