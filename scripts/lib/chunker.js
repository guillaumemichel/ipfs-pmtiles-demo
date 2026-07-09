// Chunker for ipfs-unixfs-importer that cuts the byte stream at
// predetermined block lengths, regardless of how the input is buffered.

// blockLengths must sum to the total stream length.
export function cutPointChunker(blockLengths) {
  return async function* chunk(source) {
    let blockIndex = 0;
    let pending = []; // Uint8Arrays accumulated for the current block
    let pendingSize = 0;

    for await (let buf of source) {
      while (buf.length > 0) {
        if (blockIndex >= blockLengths.length) {
          throw new Error('input longer than the cut-point plan');
        }
        const want = blockLengths[blockIndex] - pendingSize;
        if (buf.length < want) {
          pending.push(buf);
          pendingSize += buf.length;
          buf = buf.subarray(buf.length);
          continue;
        }
        pending.push(buf.subarray(0, want));
        yield concat(pending, blockLengths[blockIndex]);
        buf = buf.subarray(want);
        pending = [];
        pendingSize = 0;
        blockIndex++;
      }
    }

    if (pendingSize > 0) {
      throw new Error(
        `input ended mid-block: ${pendingSize}/${blockLengths[blockIndex]} bytes`,
      );
    }
    if (blockIndex !== blockLengths.length) {
      throw new Error(
        `input shorter than the cut-point plan: ` +
          `${blockIndex}/${blockLengths.length} blocks emitted`,
      );
    }
  };
}

function concat(parts, totalLength) {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(totalLength);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
