// Compute tile-aligned cut points and assert the archive shape the design
// depends on: clustered, deduplicated, tile ranges exactly partitioning the
// tile-data section.

export const MAX_BLOCK_SIZE = 1024 * 1024; // 1 MiB recommended maximum

// Asserts the build preconditions and returns absolute cut points as a list
// of block lengths whose sum is fileSize. First block is
// [0, tileDataOffset) (header + root dir + metadata), then one block per
// unique tile range, split at 1 MiB if ever needed.
export function computeCutPoints({ header, tileRanges, fileSize }) {
  if (!header.clustered) {
    throw new Error('archive is not clustered; rewrite it with the pmtiles CLI');
  }
  if (header.tileDataOffset + header.tileDataLength !== fileSize) {
    throw new Error('tile data section does not end at EOF');
  }

  let expectedOffset = 0;
  for (const { offset, length } of tileRanges) {
    if (offset !== expectedOffset) {
      throw new Error(
        `tile ranges do not partition the tile-data section: ` +
          `gap or overlap at relative offset ${offset} (expected ${expectedOffset})`,
      );
    }
    if (length === 0) throw new Error(`zero-length tile at offset ${offset}`);
    expectedOffset = offset + length;
  }
  if (expectedOffset !== header.tileDataLength) {
    throw new Error(
      `tile ranges cover ${expectedOffset} bytes, ` +
        `tile-data section is ${header.tileDataLength}`,
    );
  }

  const lengths = [];
  pushSplit(lengths, header.tileDataOffset);
  for (const { length } of tileRanges) pushSplit(lengths, length);
  return lengths;
}

function pushSplit(lengths, length) {
  while (length > MAX_BLOCK_SIZE) {
    lengths.push(MAX_BLOCK_SIZE);
    length -= MAX_BLOCK_SIZE;
  }
  lengths.push(length);
}
