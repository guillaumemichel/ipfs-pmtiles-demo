// Assemble the fonts verified asset (veritiles SPEC.md Part 2): import the glyph
// directory under the §9 profile so the imported directory node is FONTS_ROOT
// itself (gateway-path compatible — its bytes are name-independent, so it
// matches what any canonical importer emits), then emit its structure-only
// CAR proof. Trust travels as the CAR anchor; content travels under the root.
import { collectFiles } from './bundle.js';
import { buildProof } from './car-proof.js';
import { importTree, RecordingBlockstore } from './dag-build.js';

export async function assembleFontAsset(fontsDir) {
  const files = await collectFiles(fontsDir, 'fonts');
  const blockstore = new RecordingBlockstore();
  const roots = await importTree(files, blockstore);
  const rootCid = roots.get('fonts').cid;
  const { bytes: proof, anchor } = await buildProof(rootCid, blockstore.blocks);
  return {
    fontsDir,
    fileCount: files.length,
    blockstore,
    rootCid,
    root: rootCid.toString(),
    anchor: anchor.toString(),
    proof,
  };
}
