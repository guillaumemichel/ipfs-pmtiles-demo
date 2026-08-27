// A MASL bundle's proof is its manifest block; the raw content sections a CAR
// may also carry are optional (veritiles SPEC.md §3.2 — "optional raw blocks in
// the bag may contain asset bytes"). veritiles' `pack -- assets` inlines every
// file under the 8 MiB raw-section cap with no way to opt out, so for a glyph
// directory the "proof" comes out as a second, complete copy of the content:
// 6.28 MB here instead of 32 KB, fetched whole before the first label renders.
//
// Rewriting the bag down to the manifest alone is lossless. The anchor is the
// sha2-256 of the manifest block itself, so it is unchanged, and the client
// falls back to `{base}/{path}` for each resource exactly as the spec
// prescribes. Idempotent: thinning an already-thin bag is a no-op.
import { Buffer } from 'node:buffer';

import { CarReader, CarWriter } from '@ipld/car';

export async function manifestOnlyCar(carBytes) {
  const reader = await CarReader.fromBytes(carBytes);
  const roots = await reader.getRoots();
  if (roots.length !== 1) throw new Error(`bundle CAR must have exactly one root, found ${roots.length}`);
  const [root] = roots;
  const manifest = await reader.get(root);
  if (manifest === undefined) throw new Error(`bundle CAR is missing its root block ${root}`);

  const { writer, out } = CarWriter.create([root]);
  const chunks = [];
  const drain = (async () => { for await (const chunk of out) chunks.push(chunk); })();
  await writer.put({ cid: root, bytes: manifest.bytes });
  await writer.close();
  await drain;
  return Buffer.concat(chunks.map(Buffer.from));
}

// How many blocks a CAR carries. A thinned bundle proof holds exactly one.
export async function carBlockCount(carBytes) {
  const reader = await CarReader.fromBytes(carBytes);
  let blocks = 0;
  for await (const _ of reader.blocks()) blocks++;
  return blocks;
}
