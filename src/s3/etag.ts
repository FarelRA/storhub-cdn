import type { Env } from "../types";

export function md5Hex(bytes: Uint8Array): Promise<string> {
  // Use SubtleCrypto MD5 is not available; use SHA256 then? But S3 ETag is MD5 hex
  // In Workers, we can implement simple MD5 in JS, or use crypto.Digest? SubtleCrypto supports MD5 in some runtimes? Not.
  // We'll bundle a pure-JS MD5
  return Promise.resolve(md5(bytes));
}

// Pure JS MD5 implementation (adapted)
function md5(bytes: Uint8Array): string {
  // Convert to words
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4,
    11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af,
    0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
    0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97,
    0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ]);
  // padding
  const origLen = bytes.length;
  const bitLen = origLen * 8;
  // Append 0x80 then zeros until length %64 ==56, then append 8-byte length
  const withPaddingLength = ((origLen + 9 + 63) & ~63) ;
  const padded = new Uint8Array(withPaddingLength);
  padded.set(bytes);
  padded[origLen] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(withPaddingLength - 8, bitLen & 0xffffffff, true);
  view.setUint32(withPaddingLength - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let offset = 0; offset < withPaddingLength; offset += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(offset + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const oView = new DataView(out.buffer);
  oView.setUint32(0, a0, true);
  oView.setUint32(4, b0, true);
  oView.setUint32(8, c0, true);
  oView.setUint32(12, d0, true);
  return Array.from(out).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function etagForBytes(bytes: Uint8Array): Promise<string> {
  return md5Hex(bytes).then((h) => `"${h}"`);
}

export async function etagForChunks(chunkEtags: string[], totalSize: number): Promise<string> {
  // S3 multipart etag = md5( concat(md5(part) binary) ) + "-" + N
  // chunkEtags are hex strings like "\"ab12\""
  // Need binary md5 bytes
  if (chunkEtags.length === 1) {
    // if single chunk, use its hex as etag (but need to ensure quoted)
    let e = chunkEtags[0];
    if (!e.startsWith('"')) e = `"${e}"`;
    return e;
  }
  const concat = new Uint8Array(chunkEtags.length * 16);
  for (let i = 0; i < chunkEtags.length; i++) {
    const hex = chunkEtags[i].replace(/"/g, "");
    for (let j = 0; j < 16; j++) {
      concat[i * 16 + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
    }
  }
  const hex = await md5Hex(concat);
  return `"${hex}-${chunkEtags.length}"`;
}

