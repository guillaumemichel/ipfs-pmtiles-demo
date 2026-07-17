// Structure-only proof for a DAG artifact (veritiles SPEC.md A5): a strict-profile
// CARv1 of every dag-pb block reachable from the root, in canonical §9.1 order
// — depth-first, parents before children, directory links in name order and
// file links in index order (exactly as the importer stores them), each block
// once, raw leaves skipped. The anchor is CIDv1(car, sha2-256(proof)); it is
// byte-identical to what veritiles' reference builder emits for the same tree.
// Builders MUST fail rather than emit a sharded directory (§9) or a proof over
// 256 KiB (§9.1).
import { Buffer } from 'node:buffer';

import { CarWriter } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

const CAR_CODE = 0x0202;
const PROOF_CAP_BYTES = 262144; // §5, §9.1: the anchor names a single raw block

// The §5 header is a fixed 59-byte sequence — an 18-byte prefix, the 32-byte
// dag-pb root digest, then a 9-byte suffix — the canonical dag-cbor encoding of
// { roots: [root], version: 1 } that standard CAR writers emit. Byte-checking
// it fails the build if @ipld/car ever drifts from that container shape.
const HEADER_PREFIX = Uint8Array.from([
  0x3a, 0xa2, 0x65, 0x72, 0x6f, 0x6f, 0x74, 0x73, 0x81,
  0xd8, 0x2a, 0x58, 0x25, 0x00, 0x01, 0x70, 0x12, 0x20,
]);
const HEADER_SUFFIX = Uint8Array.from([
  0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x01,
]);

// Emit the §5/§9.1 proof for `rootCid` over a RecordingBlockstore's `blocks`
// map (cid string -> { cid, bytes }). Returns the proof bytes and the anchor.
export async function buildProof(rootCid, blocks) {
  const order = collectDagPbBlocks(rootCid, blocks);
  const bytes = await encodeCar(rootCid, order);
  assertHeaderTemplate(bytes, rootCid);
  if (bytes.length > PROOF_CAP_BYTES) {
    throw new Error(
      `proof is ${bytes.length} bytes, over the ${PROOF_CAP_BYTES} cap — ` +
        'split the tree into several artifacts (§9.1)',
    );
  }
  const anchor = CID.createV1(CAR_CODE, await sha256.digest(bytes));
  return { bytes, anchor };
}

// Depth-first, parents before children; iterating Links in stored order keeps
// directory links name-sorted and file links index-ordered (§9.1).
function collectDagPbBlocks(rootCid, blocks) {
  const seen = new Set();
  const order = [];
  const walk = (cid) => {
    if (cid.code !== dagPb.code || seen.has(cid.toString())) return; // raw leaves aren't in the proof
    seen.add(cid.toString());
    const block = blocks.get(cid.toString());
    if (block === undefined) throw new Error(`missing block ${cid} while building proof`);
    const node = dagPb.decode(block.bytes);
    if (UnixFS.unmarshal(node.Data).type === 'hamt-sharded-directory') {
      throw new Error('sharded directory: split the tree into several artifacts (§9)');
    }
    order.push(block);
    for (const link of node.Links) walk(link.Hash);
  };
  walk(rootCid);
  return order;
}

async function encodeCar(rootCid, blocks) {
  const { writer, out } = CarWriter.create([rootCid]);
  const chunks = [];
  const drain = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  for (const { cid, bytes } of blocks) await writer.put({ cid, bytes });
  await writer.close();
  await drain;
  return concatBytes(chunks);
}

function assertHeaderTemplate(proof, rootCid) {
  const expected = new Uint8Array(HEADER_PREFIX.length + 32 + HEADER_SUFFIX.length);
  expected.set(HEADER_PREFIX, 0);
  expected.set(rootCid.multihash.digest, HEADER_PREFIX.length);
  expected.set(HEADER_SUFFIX, HEADER_PREFIX.length + 32);
  const actual = proof.subarray(0, expected.length);
  if (Buffer.compare(Buffer.from(actual), Buffer.from(expected)) !== 0) {
    throw new Error(
      'proof header does not match the veritiles SPEC.md A5 template — ' +
        '@ipld/car may have changed its container encoding',
    );
  }
}

function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
