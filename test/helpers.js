// Shared test fixtures. The dumb-host and mini-package harnesses that once
// lived here drove the from-scratch client tests, which moved into the
// veritiles library in Phase B; only the deterministic byte generator remains,
// used by the chunker test.

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
