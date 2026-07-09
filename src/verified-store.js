// The one verification choke point over an ordered list of byte sources: a
// digest-keyed LRU cache, in-flight de-duplication, strict verification,
// verified/rejected stats, and ordered failover (a source that returns wrong
// or missing bytes is skipped in favour of the next). Sources hand up
// UNVERIFIED bytes; nothing leaves here unverified except fetchUnverified,
// whose single caller (bootstrap) authenticates the bytes afterwards by
// reconstructing the root CID from them.
import { VerificationError, verifyDigest } from './verify.js';

const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

export class VerifiedStore {
  #sources;
  #cache = new Map(); // digest hex -> Uint8Array, insertion order = LRU
  #cacheBytes = 0;
  #maxCacheBytes;
  #inflight = new Map(); // key -> { promise, controller, refs }
  stats = { verified: 0, rejected: 0 };

  constructor(sources, { maxCacheBytes = DEFAULT_CACHE_BYTES } = {}) {
    if (!sources?.length) throw new Error('at least one source is required');
    this.#sources = sources;
    this.#maxCacheBytes = maxCacheBytes;
  }

  // Verified cached bytes for a digest (LRU-refreshed), or undefined. Lets
  // the map reader plan which leaves still need fetching and split runs.
  getCached(digest) {
    const bytes = this.#cache.get(digest);
    if (bytes === undefined) return undefined;
    this.#cache.delete(digest);
    this.#cache.set(digest, bytes);
    return bytes;
  }

  // Verified whole small file (proof shard, meta, font proofs, glyph) with
  // a known digest: plain GET, hash compare, digest-keyed cache + dedup.
  async fetchWhole(path, digest, cap, { signal } = {}) {
    signal?.throwIfAborted();
    const cached = this.getCached(digest);
    if (cached !== undefined) return cached;
    return this.#dedup(`whole:${digest}`, signal, (s) => this.#fetchWholeFrom(path, digest, cap, s));
  }

  // Verified slices for a run of file-contiguous leaves, aligned with
  // `leaves` [{offset, length, digest}]. One Range request per run; every
  // slice is verified before any is cached, so one bad leaf sends the whole
  // run to the next source instead of poisoning the cache. Concurrent
  // identical runs share one fetch + one verification pass.
  async fetchRun(path, leaves, { signal } = {}) {
    signal?.throwIfAborted();
    const start = leaves[0].offset;
    const total = leaves.reduce((n, l) => n + l.length, 0);
    return this.#dedup(`run:${path}:${start}+${total}`, signal, (s) =>
      this.#fetchRunFrom(path, leaves, start, total, s),
    );
  }

  // UNVERIFIED ranged body — the speculative half of a parallel read: fetched
  // while the proof descent is still in flight, then adopted leaf-by-leaf via
  // adoptSlices once digests are known, or discarded. Never cached here.
  async fetchRangeUnverified(path, start, length, { signal } = {}) {
    signal?.throwIfAborted();
    return this.#dedup(`spec:${path}:${start}+${length}`, signal, async (s) => {
      const errors = [];
      for (const source of this.#sources) {
        try {
          return await source.fetchRange(path, start, length, { signal: s });
        } catch (err) {
          if (s.aborted) throw err;
          errors.push(err);
        }
      }
      throw new AggregateError(errors, `all sources failed for ${path}`);
    });
  }

  // Verified slices for file-contiguous leaves cut from an UNVERIFIED
  // speculative body (body[0] is file offset bodyStart): every slice is
  // digest-checked before any is cached, so a bad body poisons nothing —
  // the caller falls back to an ordinary verified run fetch.
  async adoptSlices(leaves, body, bodyStart, { signal } = {}) {
    signal?.throwIfAborted();
    try {
      const slices = leaves.map((leaf) => {
        const from = leaf.offset - bodyStart;
        return body.slice(from, from + leaf.length); // copy: no shared-buffer retention
      });
      for (let i = 0; i < leaves.length; i++) {
        if (slices[i].length !== leaves[i].length) {
          throw new VerificationError(`speculative body truncated at ${leaves[i].offset}`);
        }
        await verifyDigest(leaves[i].digest, slices[i], `speculative@${leaves[i].offset}`);
      }
      for (let i = 0; i < leaves.length; i++) {
        this.stats.verified++;
        this.#cachePut(leaves[i].digest, slices[i]);
      }
      return slices;
    } catch (err) {
      if (err instanceof VerificationError) this.stats.rejected++;
      throw err;
    }
  }

  // UNVERIFIED whole file — bootstrap only: metadata.json cannot be checked
  // until its own bytes rebuild the root CID. Never cached here.
  async fetchUnverified(path, cap, { signal } = {}) {
    signal?.throwIfAborted();
    return this.#dedup(`raw:${path}`, signal, (s) => this.#fetchUnverifiedFrom(path, cap, s));
  }

  // Ref-counted in-flight de-duplication with correct shared-abort semantics:
  // one consumer aborting must not cancel a fetch another still awaits, and a
  // consumer that joins after the last one aborted must start a fresh fetch
  // rather than ride the now-aborted shared controller.
  async #dedup(key, signal, run) {
    let entry = this.#inflight.get(key);
    if (entry === undefined) {
      const controller = new AbortController();
      entry = { controller, refs: 0 };
      entry.promise = run(controller.signal).finally(() => {
        if (this.#inflight.get(key) === entry) this.#inflight.delete(key);
      });
      this.#inflight.set(key, entry);
    }

    entry.refs++;
    const onAbort = () => {
      if (--entry.refs === 0) {
        if (this.#inflight.get(key) === entry) this.#inflight.delete(key);
        entry.controller.abort(signal?.reason);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await entry.promise;
      signal?.throwIfAborted();
      return result;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #fetchWholeFrom(path, digest, cap, signal) {
    const errors = [];
    for (const source of this.#sources) {
      try {
        const bytes = await source.fetchWhole(path, cap, { signal });
        await verifyDigest(digest, bytes, path);
        this.stats.verified++;
        this.#cachePut(digest, bytes);
        return bytes;
      } catch (err) {
        if (signal.aborted) throw err;
        if (err instanceof VerificationError) this.stats.rejected++;
        errors.push(err);
      }
    }
    throw new AggregateError(errors, `all sources failed for ${path}`);
  }

  async #fetchRunFrom(path, leaves, start, total, signal) {
    const errors = [];
    for (const source of this.#sources) {
      try {
        const body = await source.fetchRange(path, start, total, { signal });
        // Ranged lengths are known from the proofs; enforce before hashing.
        if (body.length !== total) {
          throw new VerificationError(`${path}: got ${body.length} bytes, expected ${total}`);
        }
        const slices = leaves.map((leaf) => {
          const from = leaf.offset - start;
          return body.slice(from, from + leaf.length); // copy: no shared-buffer retention
        });
        for (let i = 0; i < leaves.length; i++) {
          await verifyDigest(leaves[i].digest, slices[i], `${path}@${leaves[i].offset}`);
        }
        for (let i = 0; i < leaves.length; i++) {
          this.stats.verified++;
          this.#cachePut(leaves[i].digest, slices[i]);
        }
        return slices;
      } catch (err) {
        if (signal.aborted) throw err;
        if (err instanceof VerificationError) this.stats.rejected++;
        errors.push(err);
      }
    }
    throw new AggregateError(errors, `all sources failed for run on ${path}`);
  }

  async #fetchUnverifiedFrom(path, cap, signal) {
    const errors = [];
    for (const source of this.#sources) {
      try {
        return await source.fetchWhole(path, cap, { signal });
      } catch (err) {
        if (signal.aborted) throw err;
        errors.push(err);
      }
    }
    throw new AggregateError(errors, `all sources failed for ${path}`);
  }

  #cachePut(key, bytes) {
    if (this.#cache.has(key)) return;
    this.#cache.set(key, bytes);
    this.#cacheBytes += bytes.length;
    for (const [k, v] of this.#cache) {
      if (this.#cacheBytes <= this.#maxCacheBytes) break;
      this.#cache.delete(k);
      this.#cacheBytes -= v.length;
    }
  }
}
