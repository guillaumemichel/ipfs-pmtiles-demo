// Build-side constants for fable's map-package proof format (the sharded
// `proofs/` tree inside every map/elevation package). This is the publisher
// half of the wire contract; the browser-side decoder now lives in the
// veritiles library (VerifiedSource), which reads exactly this layout. The
// encoders in proof-encode.js / proofs-build.js reference these constants.
//
//   shard file := ( u32le(relativeOffset) digest32 )+           fixed 36 B records
//   meta file  := ( kind:u8 u64le(rangeLength ≥ 1) digest32 )+  fixed 41 B records

export const DIGEST_LENGTH = 32;
export const SHARD_RECORD_SIZE = 4 + DIGEST_LENGTH;
export const SHARD_FILE_CAP = 64 * 1024; // hard limit on shard file size
export const MAX_SHARD_RECORDS = Math.floor(SHARD_FILE_CAP / SHARD_RECORD_SIZE);
export const META_RECORD_SIZE = 1 + 8 + DIGEST_LENGTH;
export const KIND_SHARD = 0;
export const KIND_DIR = 1;

// Filename convention: 16 lowercase hex digits of the absolute start offset.
export function shardName(startOffset) {
  return startOffset.toString(16).padStart(16, '0');
}
