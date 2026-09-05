import type { Env } from "../types";
import { downloadAsset } from "./client";
import type { Chunk } from "../types";

/**
 * Create a ReadableStream that concatenates multiple chunk assets in order,
 * supporting byte-range slicing across chunks.
 * Streaming: each GitHub asset is fetched only when needed, and piped directly.
 */
export function createChunkedStream(
  env: Env,
  owner: string,
  repo: string,
  chunks: Chunk[],
  range?: { start: number; end: number },
): ReadableStream<Uint8Array> {
  // If no range, stream all
  let startOffset = range?.start ?? 0;
  let endOffset = range?.end ?? chunks.reduce((a, c) => a + c.size, 0) - 1;
  if (endOffset < startOffset) endOffset = startOffset;

  // Find chunk indices
  let curLogicalOffset = 0;
  // Build list of {chunk, sliceStart, sliceEnd}
  const slices: { chunk: Chunk; sliceStart: number; sliceEnd: number }[] = [];
  for (const ch of chunks) {
    const chStart = curLogicalOffset;
    const chEnd = curLogicalOffset + ch.size - 1;
    if (chEnd < startOffset || chStart > endOffset) {
      curLogicalOffset += ch.size;
      continue;
    }
    const sliceStart = Math.max(0, startOffset - chStart);
    const sliceEnd = Math.min(ch.size - 1, endOffset - chStart);
    slices.push({ chunk: ch, sliceStart, sliceEnd });
    curLogicalOffset += ch.size;
    if (chStart > endOffset) break;
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const { chunk, sliceStart, sliceEnd } of slices) {
          const needsSlice = sliceStart !== 0 || sliceEnd !== chunk.size - 1;
          // For sliced chunks, pass Range header to avoid downloading full 48MB
          const rangeHeader = needsSlice ? `bytes=${sliceStart}-${sliceEnd}` : undefined;
          const res = await downloadAsset(env, owner, repo, chunk.assetId, rangeHeader);
          if (!res.body) {
            const buf = new Uint8Array(await res.arrayBuffer());
            const sliced = buf.slice(sliceStart, sliceEnd + 1);
            controller.enqueue(sliced);
            continue;
          }
          // needsSlice already computed above
          if (!needsSlice) {
            const reader = res.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) controller.enqueue(value);
            }
          } else {
            // Buffer and slice (since Range per GitHub asset not directly supported via query)
            // We could try to pass Range header to download, but downloadAsset uses API which may not support range.
            // Simplest: download fully then slice, still streaming per chunk
            const reader = res.body.getReader();
            let bytesNeeded = sliceEnd - sliceStart + 1;
            let offsetInChunk = 0;
            while (bytesNeeded > 0) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value) continue;
              const chunkLen = value.length;
              const chunkStart = offsetInChunk;
              const chunkEnd = offsetInChunk + chunkLen - 1;
              offsetInChunk += chunkLen;

              // intersect with desired slice
              if (chunkEnd < sliceStart) continue;
              if (chunkStart > sliceEnd) break;
              const from = Math.max(0, sliceStart - chunkStart);
              const to = Math.min(chunkLen - 1, sliceEnd - chunkStart);
              const sliced = value.slice(from, to + 1);
              controller.enqueue(sliced);
              bytesNeeded -= sliced.length;
            }
          }
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

export function getTotalSize(chunks: Chunk[]): number {
  return chunks.reduce((a, c) => a + c.size, 0);
}
