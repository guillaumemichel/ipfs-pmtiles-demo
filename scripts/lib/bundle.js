// The reproducible core of the build, extracted so the golden tests can
// re-derive the same root CIDs. Two independent packages, each a root
// directory CID a client can bootstrap from:
//
//   map package   map.pmtiles (tile-aligned import) + proofs/ tree + metadata.json
//   font package  fonts/ files + one proofs file + metadata.json
//
// Pure functions of the input files + installed tool versions — no
// timestamps, no machine-specific data. metadata.json is always generated
// last because it lists its siblings' CIDs (never its own — the client
// self-hashes it instead).
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import * as dagPb from '@ipld/dag-pb';

import { RAW_CODE } from '../../src/verify.js';
import { cutPointChunker } from './chunker.js';
import { computeCutPoints } from './cutpoints.js';
import {
  buildDirectoryNode,
  importChunkedFile,
  importTree,
  RecordingBlockstore,
} from './dag-build.js';
import { parseArchive } from './pmtiles-parse.js';
import { encodeFontProofs } from './proof-encode.js';
import { buildProofTree, SHARD_CAP_BYTES, sha256 } from './proofs-build.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const FORMAT_VERSION = 2;

// Provenance of the demo font set (data/fonts) — shared by the build and
// the golden test so both derive the same fonts root CID.
export const FONT_SET_PROVENANCE = { source: { assets: 'protomaps/basemaps-assets' } };

// Every non-map file must be a single raw UnixFS leaf so that its served
// bytes hash straight to its file CID's digest (the default chunker splits
// at 256 KiB). Clients rely on this bound to cap whole-file reads.
const SINGLE_LEAF_MAX = 256 * 1024;

// Map package from a PMTiles archive: parse, assert the tile-aligned shape,
// import, prove.
export async function assembleMapBundle({ fileBytes }) {
  const { header, tileRanges } = parseArchive(fileBytes);
  const cuts = computeCutPoints({ header, tileRanges, fileSize: fileBytes.length });
  const dag = await assembleMapDag({
    mapBytes: fileBytes,
    cuts,
    provenance: mapProvenance(fileBytes, header),
  });
  return { header, tileRanges, ...dag };
}

// Font package from a directory of glyph files.
export async function assembleFontBundle({ fontsDir, provenance = {} }) {
  const fontFiles = await collectFiles(fontsDir, 'fonts');
  return assembleFontDag({ fontFiles, provenance });
}

// Map DAG for any tile-aligned archive, reused by tests on synthetic inputs.
export async function assembleMapDag({ mapBytes, cuts, provenance = {}, shardCap = SHARD_CAP_BYTES, metaMaxEntries }) {
  const blockstore = new RecordingBlockstore();
  const mapEntry = await importChunkedFile(mapBytes, cutPointChunker(cuts), blockstore);
  const leaves = fileLeaves(blockstore.blocks, mapEntry.cid);
  const covered = leaves.reduce((n, l) => n + l.length, 0);
  if (covered !== mapBytes.length) {
    throw new Error(`leaves cover ${covered} bytes, file is ${mapBytes.length}`);
  }

  const proofTree = buildProofTree(leaves, { shardCap, maxEntries: metaMaxEntries });
  const entries = proofTree.files.map((f) => ({ path: `proofs/${f.path}`, content: f.content }));
  assertSingleLeaf(entries);
  const roots = await importTree(entries, blockstore);

  const children = [
    { name: 'map.pmtiles', cid: mapEntry.cid, size: mapEntry.size },
    { name: 'proofs', ...roots.get('proofs') },
  ];
  const metadataBytes = buildManifest({
    section: {
      map: { file: 'map.pmtiles', size: mapBytes.length },
      proofs: {
        dir: 'proofs',
        metaDigest: Buffer.from(sha256(proofTree.topMeta)).toString('hex'),
        shardCapBytes: shardCap,
      },
    },
    children,
    provenance,
  });
  const root = await sealRoot(children, metadataBytes, blockstore);
  return { blockstore, mapEntry, leaves, proofTree, metadataBytes, children, root };
}

// Font DAG: fontFiles are {path: 'fonts/…', content}; the proofs file maps
// each path relative to fonts/ to the sha256 of its bytes.
export async function assembleFontDag({ fontFiles, provenance = {} }) {
  if (fontFiles.length === 0) throw new Error('at least one font file is required');
  const blockstore = new RecordingBlockstore();
  const proofsBytes = encodeFontProofs(
    fontFiles.map(({ path, content }) => ({
      path: path.replace(/^fonts\//, ''),
      digest: sha256(content),
    })),
  );
  const entries = [...fontFiles, { path: 'proofs', content: proofsBytes }];
  assertSingleLeaf(entries);
  const roots = await importTree(entries, blockstore);

  const children = [
    { name: 'fonts', ...roots.get('fonts') },
    { name: 'proofs', ...roots.get('proofs') },
  ];
  const metadataBytes = buildManifest({
    section: { fonts: { dir: 'fonts', proofs: 'proofs' } },
    children,
    provenance,
  });
  const root = await sealRoot(children, metadataBytes, blockstore);
  return { blockstore, fontFiles, proofsBytes, metadataBytes, children, root };
}

// The bootstrap manifest: everything a client needs to verify the package
// from the root CID alone. `children` lists every root entry except
// metadata.json itself — the client inserts its own hash of the fetched
// bytes and requires the rebuilt directory node to equal the root CID.
function buildManifest({ section, children, provenance }) {
  const metadata = {
    formatVersion: FORMAT_VERSION,
    ...provenance,
    hash: 'sha2-256',
    ...section,
    children: children.map((c) => ({
      name: c.name,
      cid: c.cid.toString(),
      tsize: Number(c.size),
    })),
  };
  return Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
}

function assertSingleLeaf(entries) {
  for (const entry of entries) {
    if (entry.content.length > SINGLE_LEAF_MAX) {
      throw new Error(`${entry.path}: ${entry.content.length} B exceeds single-leaf max`);
    }
  }
}

// Import metadata.json and hand-build the root directory node over it and
// its siblings. The client reconstructs that node using Tsize = byte length
// for metadata.json; fail the build loudly if importer semantics ever drift.
async function sealRoot(children, metadataBytes, blockstore) {
  const metaRoots = await importTree([{ path: 'metadata.json', content: metadataBytes }], blockstore);
  const metadataEntry = metaRoots.get('metadata.json');
  if (Number(metadataEntry.size) !== metadataBytes.length) {
    throw new Error(
      `metadata.json Tsize ${metadataEntry.size} != byte length ${metadataBytes.length}`,
    );
  }
  return buildDirectoryNode([...children, { name: 'metadata.json', ...metadataEntry }], blockstore);
}

// Provenance for humans and tools. No timestamps or machine-specific data:
// must be identical across rebuilds.
function mapProvenance(fileBytes, header) {
  const internal = JSON.parse(
    gunzipSync(
      fileBytes.subarray(
        header.jsonMetadataOffset,
        header.jsonMetadataOffset + header.jsonMetadataLength,
      ),
    ).toString('utf8'),
  );
  const importerVersion = createRequire(import.meta.url)(
    join(repoRoot, 'node_modules/ipfs-unixfs-importer/package.json'),
  ).version;
  return {
    source: { build: 'protomaps 20250902', maxZoom: header.maxZoom },
    attribution: internal.attribution ?? '',
    chunking: {
      strategy: 'tile-aligned',
      toolVersion: `ipfs-unixfs-importer@${importerVersion}`,
    },
  };
}

// [{offset, length, digest}] for every raw leaf of a UnixFS file, in file
// order — works for flat and balanced layouts alike. The proofs are, by
// construction, the leaf CIDs' own digests: the sidecar tree and the UnixFS
// DAG commit to identical bytes.
export function fileLeaves(blocks, rootCid) {
  const leaves = [];
  let offset = 0;
  const walk = (cid) => {
    const block = blocks.get(cid.toString());
    if (block === undefined) throw new Error(`missing block ${cid}`);
    if (cid.code === RAW_CODE) {
      leaves.push({ offset, length: block.bytes.length, digest: cid.multihash.digest });
      offset += block.bytes.length;
      return;
    }
    for (const link of dagPb.decode(block.bytes).Links) walk(link.Hash);
  };
  walk(rootCid);
  return leaves;
}

export async function collectFiles(dir, prefix) {
  const out = [];
  for (const dirent of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!dirent.isFile()) continue;
    const abs = join(dirent.parentPath, dirent.name);
    out.push({ path: join(prefix, relative(dir, abs)), content: await readFile(abs) });
  }
  return out;
}
