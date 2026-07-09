// Bootstrap trust from a single root CID and a dumb host. metadata.json is
// the only unverified fetch the client ever makes: its bytes are hashed, the
// root directory node is rebuilt from the manifest's children plus that
// self-computed link, and the result must equal the configured root CID.
// After that, every value in the manifest is authenticated.
//
// The root node itself cannot be a file inside its own directory (its bytes
// would have to contain their own hash), which is exactly why the manifest
// lists `{name, cid, tsize}` for every root child EXCEPT metadata.json: the
// client supplies that one link itself from the bytes it fetched.
//
// Both package kinds bootstrap this way and differ only in the section the
// manifest carries: a map package declares `map` + `proofs`, a font package
// declares `fonts`.
import * as dagPb from '@ipld/dag-pb';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import {
  DAG_PB_CODE,
  DIGEST_HEX_RE,
  RAW_CODE,
  SHA2_256_CODE,
  sha256,
  toHex,
  VerificationError,
} from './verify.js';

const FORMAT_VERSION = 2;
const METADATA_NAME = 'metadata.json';
const METADATA_CAP = 1024 * 1024;
const MAX_CHILDREN = 64;
// A UnixFS directory node's Data field is the constant protobuf {Type: 1}.
const DIR_NODE_DATA = Uint8Array.of(0x08, 0x01);

// Map package manifest:
// { mapFile, mapSize, proofsDir, proofsMetaDigest, children }
export function openMapManifest(rootCidText, store, opts = {}) {
  return openManifest(rootCidText, store, parseMapSection, opts);
}

// Font package manifest: { fontsDir, proofsFile, proofsDigest, children }
export function openFontManifest(rootCidText, store, opts = {}) {
  return openManifest(rootCidText, store, parseFontSection, opts);
}

async function openManifest(rootCidText, store, parseSection, { signal } = {}) {
  const rootCid = parseCid(rootCidText, 'root');
  if (rootCid.code !== DAG_PB_CODE || rootCid.multihash.code !== SHA2_256_CODE) {
    throw new VerificationError('root CID must be dag-pb with sha2-256');
  }

  const bytes = await store.fetchUnverified(METADATA_NAME, METADATA_CAP, { signal });
  let raw;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new VerificationError('metadata.json: not valid UTF-8 JSON');
  }
  if (raw?.formatVersion !== FORMAT_VERSION) {
    throw new VerificationError(`metadata.json: unsupported formatVersion ${raw?.formatVersion}`);
  }
  if (raw.hash !== 'sha2-256') {
    throw new VerificationError(`metadata.json: unsupported hash ${raw.hash}`);
  }
  const children = parseChildren(raw.children);
  const manifest = parseSection(raw, children);

  await reconstructRoot(rootCid, bytes, children);
  return { ...manifest, children };
}

// The reconstruction: hash the fetched manifest bytes into the self link,
// rebuild the canonical UnixFS directory node from `children` + that link,
// and require its CID to equal the trust anchor. A second preimage on
// sha2-256 is the only way a tampered manifest passes.
async function reconstructRoot(rootCid, bytes, children) {
  const selfCid = CID.createV1(RAW_CODE, Digest.create(SHA2_256_CODE, await sha256(bytes)));
  const links = [
    ...children.map((c) => ({ Name: c.name, Hash: c.cid, Tsize: c.tsize })),
    { Name: METADATA_NAME, Hash: selfCid, Tsize: bytes.length },
  ].sort((a, b) => (a.Name < b.Name ? -1 : 1));
  let rebuilt;
  try {
    const node = dagPb.encode({ Data: DIR_NODE_DATA, Links: links });
    rebuilt = CID.createV1(DAG_PB_CODE, Digest.create(SHA2_256_CODE, await sha256(node)));
  } catch (err) {
    // dag-pb encode rejects links that are not in canonical UTF-8 byte order
    // — reachable only with pathological non-ASCII child names in a tampered
    // manifest (an honest package is ASCII, where our sort already agrees).
    // Normalize to a fail-closed VerificationError so callers that branch on
    // the error type (store failover) aren't handed a raw TypeError.
    throw new VerificationError(`metadata.json: cannot reconstruct root node (${err.message})`);
  }
  if (!rebuilt.equals(rootCid)) {
    throw new VerificationError(
      `metadata.json does not reconstruct the root: got ${rebuilt}, want ${rootCid}`,
    );
  }
}

function parseMapSection(raw, children) {
  const mapFile = assertName(raw.map?.file, 'map.file');
  const mapSize = assertSize(raw.map?.size, 'map.size');
  const proofsDir = assertName(raw.proofs?.dir, 'proofs.dir');
  const metaDigest = raw.proofs?.metaDigest;
  if (typeof metaDigest !== 'string' || !DIGEST_HEX_RE.test(metaDigest)) {
    throw new VerificationError('metadata.json: proofs.metaDigest is not a hex sha2-256 digest');
  }
  // proofs.shardCapBytes is publisher documentation only: the client enforces
  // the format's own 64 KiB shard cap (proof-format.js), so it is not read.
  requireChildren(children, [mapFile, proofsDir]);
  return { mapFile, mapSize, proofsDir, proofsMetaDigest: metaDigest };
}

function parseFontSection(raw, children) {
  const fontsDir = assertName(raw.fonts?.dir, 'fonts.dir');
  const proofsFile = assertName(raw.fonts?.proofs, 'fonts.proofs');
  requireChildren(children, [fontsDir, proofsFile]);
  return { fontsDir, proofsFile, proofsDigest: rawLeafDigest(children, proofsFile) };
}

// Strict validation of the untrusted children list; every entry is later
// load-bearing in the reconstruction, so malformed input is a hard reject
// before any use.
function parseChildren(rawChildren) {
  if (!Array.isArray(rawChildren) || rawChildren.length === 0 || rawChildren.length > MAX_CHILDREN) {
    throw new VerificationError('metadata.json: children must be a non-empty array');
  }
  const seen = new Set();
  return rawChildren.map((c, i) => {
    const name = assertName(c?.name, `children[${i}].name`);
    if (name === METADATA_NAME) {
      throw new VerificationError('metadata.json: children must not list metadata.json itself');
    }
    if (seen.has(name)) throw new VerificationError(`metadata.json: duplicate child ${name}`);
    seen.add(name);
    return { name, cid: parseCid(c?.cid, name), tsize: assertSize(c?.tsize, `${name}.tsize`) };
  });
}

function requireChildren(children, names) {
  for (const name of names) {
    if (!children.some((c) => c.name === name)) {
      throw new VerificationError(`metadata.json: children missing entry for ${name}`);
    }
  }
}

// A single-raw-leaf file's CID multihash IS the sha256 of its served bytes —
// how a child entry doubles as the content digest of a whole-file fetch.
function rawLeafDigest(children, name) {
  const cid = children.find((c) => c.name === name).cid;
  if (cid.code !== RAW_CODE || cid.multihash.code !== SHA2_256_CODE) {
    throw new VerificationError(`metadata.json: ${name} must be a raw sha2-256 leaf`);
  }
  return toHex(cid.multihash.digest);
}

function parseCid(text, label) {
  if (typeof text !== 'string') {
    throw new VerificationError(`metadata.json: ${label} CID is not a string`);
  }
  try {
    return CID.parse(text);
  } catch {
    throw new VerificationError(`metadata.json: ${label} CID does not parse`);
  }
}

function assertName(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    value.includes('/') ||
    value === '.' ||
    value === '..'
  ) {
    throw new VerificationError(`metadata.json: invalid name for ${label}`);
  }
  return value;
}

function assertSize(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VerificationError(`metadata.json: invalid size for ${label}`);
  }
  return value;
}
