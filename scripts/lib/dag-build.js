// Build the tile-aligned UnixFS DAG: import passes into a memory blockstore,
// hand-built root directory node, CAR serialization.
import { CarWriter } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import { MemoryBlockstore } from 'blockstore-core/memory';
import { UnixFS } from 'ipfs-unixfs';
import { importer } from 'ipfs-unixfs-importer';
import { flat } from 'ipfs-unixfs-importer/layout';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

// interface-blockstore streams from getAll() and MemoryBlockstore keys by
// multihash (losing the codec), so blocks for the CAR are recorded at put()
// time instead.
export class RecordingBlockstore extends MemoryBlockstore {
  blocks = new Map(); // cid string -> { cid, bytes }

  async put(cid, bytes) {
    this.blocks.set(cid.toString(), { cid, bytes });
    return super.put(cid, bytes);
  }
}

// Options pinned explicitly so a future importer default change cannot
// silently alter the root CID.
const IMPORT_OPTIONS = { rawLeaves: true, cidVersion: 1 };

export async function importChunkedFile(bytes, chunker, blockstore) {
  const results = [];
  const source = [{ content: bytes }];
  const opts = { ...IMPORT_OPTIONS, chunker, layout: flat() };
  for await (const entry of importer(source, blockstore, opts)) {
    results.push(entry);
  }
  if (results.length !== 1) {
    throw new Error(`expected 1 import result, got ${results.length}`);
  }
  return results[0]; // { cid, size, unixfs }
}

// Import a set of {path, content} entries with the default chunker and
// return a map of top-level path -> { cid, size }.
export async function importTree(entries, blockstore) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
  const roots = new Map();
  for await (const entry of importer(sorted, blockstore, IMPORT_OPTIONS)) {
    if (!entry.path.includes('/')) {
      roots.set(entry.path, { cid: entry.cid, size: entry.size });
    }
  }
  return roots;
}

// Hand-built dag-pb UnixFS directory node. links: [{name, cid, size}],
// sizes are cumulative DAG sizes (Tsize).
export async function buildDirectoryNode(links, blockstore) {
  const sorted = [...links].sort((a, b) => (a.name < b.name ? -1 : 1));
  const node = {
    Data: new UnixFS({ type: 'directory' }).marshal(),
    Links: sorted.map((l) => ({ Name: l.name, Hash: l.cid, Tsize: Number(l.size) })),
  };
  const bytes = dagPb.encode(node);
  const cid = CID.createV1(dagPb.code, await sha256.digest(bytes));
  await blockstore.put(cid, bytes);
  return { cid, bytes };
}

export async function writeCar(rootCid, blocks, outStream) {
  const { writer, out } = CarWriter.create([rootCid]);
  const drain = (async () => {
    for await (const chunk of out) outStream.write(chunk);
  })();
  for (const { cid, bytes } of blocks.values()) {
    await writer.put({ cid, bytes });
  }
  await writer.close();
  await drain;
}
