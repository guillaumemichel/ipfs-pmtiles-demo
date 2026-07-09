// Digest verification primitives: sha2-256 only — the hash every CID and
// proof record in the bundle uses. WebCrypto requires a secure context
// (https or localhost). Digests travel as lowercase hex strings client-side.

export const RAW_CODE = 0x55;
export const DAG_PB_CODE = 0x70;
export const SHA2_256_CODE = 0x12;
export const DIGEST_HEX_RE = /^[0-9a-f]{64}$/;

export class VerificationError extends Error {
  name = 'VerificationError';
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

// Throws unless sha256(bytes) matches the expected lowercase hex digest.
export async function verifyDigest(expectedHex, bytes, label) {
  if (!DIGEST_HEX_RE.test(expectedHex)) {
    throw new VerificationError(`${label}: malformed expected digest`);
  }
  if (toHex(await sha256(bytes)) !== expectedHex) {
    throw new VerificationError(`${label}: digest mismatch`);
  }
}

export function toHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
