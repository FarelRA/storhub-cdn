export function getChunkSize(env: { CHUNK_SIZE?: string }): number {
  const v = env.CHUNK_SIZE ? parseInt(env.CHUNK_SIZE, 10) : 48 * 1024 * 1024;
  if (Number.isNaN(v) || v <= 0) return 48 * 1024 * 1024;
  // clamp to 5KB - 90MB (worker limit) - allow small for tests
  return Math.min(Math.max(v, 5 * 1024), 90 * 1024 * 1024);
}

export function parseBucketKey(url: URL, host: string, env: { BUCKET_REPOS?: string; CUSTOM_DOMAIN?: string }): { bucket: string | null; key: string } {
  // Try to decode pathname safely; malformed % throws, return 400-like empty
  let pathname: string;
  try {
    // Decode each segment separately to preserve encoded slashes
    pathname = url.pathname
      .split("/")
      .map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg;
        }
      })
      .join("/");
  } catch {
    pathname = url.pathname;
  }
  // Path-style first
  const pathParts = pathname.replace(/^\/+/, "").split("/");
  // If virtual-host: host = bucket.s3.example.com => bucket is first label
  // We need to know base domain. We can use env var CUSTOM_DOMAIN? For now handle any subdomain before first dot as potential bucket
  // But to avoid false positive with worker.dev, we check header x-forwarded bucket? Instead parse host.

  // Attempt virtual-host detection: if url has bucket in host, the pathname is just /key
  // We'll look at Host header vs known buckets
  let bucket: string | null = null;
  let key: string = "";

  // Check if we should treat host as bucket prefix:
  // If host contains '.' and we have BUCKET_REPOS mapping, check if host prefix matches a bucket
  // Or if host has pattern <bucket>.<anything> and path does not start with /<bucket>/
  // We'll use heuristic: if host prefix before first dot length >=2 and does not contain ':' and we have at least 1 bucket mapping, test if prefix is in mapping
  // Also fallback: if host is like "bucket.s3.example.com" where bucket is encoded
  const hostNoPort = host.split(":")[0].toLowerCase();
  const customDomain = (env as any).CUSTOM_DOMAIN ? String((env as any).CUSTOM_DOMAIN).toLowerCase().replace(/^https?:\/\//, "").split("/")[0] : null;

  let knownBuckets: string[] = [];
  if (env.BUCKET_REPOS) {
    try {
      const m = JSON.parse(env.BUCKET_REPOS);
      knownBuckets = Object.keys(m);
    } catch {}
  }

  const denyPrefixes = ["www", "api", "s3", "storhub"];
  const labels = hostNoPort.split(".");
  // If CUSTOM_DOMAIN is set, require host to end with it for virtual-host
  const isCustomDomain = customDomain ? hostNoPort === customDomain || hostNoPort.endsWith(`.${customDomain}`) : !hostNoPort.endsWith("workers.dev");
  const possibleBucketFromHost = labels.length >= 2 ? labels[0] : null;
  const hostBucketCandidate = (() => {
    if (!possibleBucketFromHost || denyPrefixes.includes(possibleBucketFromHost)) return null;
    if (customDomain) {
      if (!hostNoPort.endsWith(customDomain)) return null;
      // host is <bucket>.customDomain or <bucket>.s3.customDomain etc - extract bucket as first label
      return possibleBucketFromHost;
    }
    // Without custom domain, only allow if known bucket
    if (knownBuckets.includes(possibleBucketFromHost)) return possibleBucketFromHost;
    return null;
  })();

  if (hostBucketCandidate) {
    // Path-style has precedence if path starts with bucket name that is known, unless host is custom domain
    if (customDomain || knownBuckets.includes(hostBucketCandidate)) {
      // If custom domain, virtual-host always wins
      if (customDomain) {
        bucket = hostBucketCandidate;
        key = pathname.replace(/^\/+/, "");
      } else if (knownBuckets.includes(hostBucketCandidate)) {
        bucket = hostBucketCandidate;
        key = pathname.replace(/^\/+/, "");
      }
    }
  } else if (possibleBucketFromHost && labels.length >= 3 && !hostNoPort.endsWith("workers.dev")) {
    // Fallback permissive for custom domain without explicit CUSTOM_DOMAIN
    const isWorkersDev = hostNoPort.endsWith("workers.dev");
    if (!isWorkersDev && possibleBucketFromHost && !denyPrefixes.includes(possibleBucketFromHost) && pathParts[0] !== possibleBucketFromHost) {
      if (knownBuckets.length === 0 || !knownBuckets.includes(pathParts[0])) {
        bucket = possibleBucketFromHost;
        key = pathname.replace(/^\/+/, "");
      }
    }
  }

  if (!bucket) {
    // path-style fallback
    if (!pathname || pathname === "/" || pathname === "") {
      bucket = null;
      key = "";
    } else {
      bucket = pathParts[0] || null;
      key = pathParts.slice(1).join("/");
      // handle key with encoded slash? Already decoded
    }
  }
  // If bucket is null and key is bucket? handle case where host bucket but path empty
  return { bucket, key };
}

export function parseRange(rangeHeader: string | null, total: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  // Format: bytes=0-99, bytes=100-, bytes=-500
  const m = rangeHeader.match(/bytes\s*=\s*(\d*)-(\d*)/i);
  if (!m) return null;
  let startStr = m[1];
  let endStr = m[2];
  let start: number, end: number;
  if (startStr === "" && endStr !== "") {
    // suffix
    const suffix = parseInt(endStr, 10);
    if (Number.isNaN(suffix)) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else if (startStr !== "" && endStr === "") {
    start = parseInt(startStr, 10);
    end = total - 1;
  } else if (startStr !== "" && endStr !== "") {
    start = parseInt(startStr, 10);
    end = parseInt(endStr, 10);
    if (end >= total) end = total - 1;
  } else {
    return null;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) return null;
  return { start, end };
}

export function parseAmzMeta(headers: Headers): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const [k, v] of headers.entries()) {
    const lk = k.toLowerCase();
    if (lk.startsWith("x-amz-meta-")) {
      const mk = lk.slice("x-amz-meta-".length);
      meta[mk] = v;
    }
  }
  return meta;
}

export function formatRFC1123(iso: string): string {
  return new Date(iso).toUTCString();
}

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

export function parseContentDisposition(headers: Headers): string | undefined {
  return headers.get("content-disposition") || undefined;
}

export function parseCacheControl(headers: Headers): string | undefined {
  return headers.get("cache-control") || undefined;
}

export function parseExpires(headers: Headers): string | undefined {
  return headers.get("expires") || undefined;
}

export function generateRequestId(): string {
  // mimic S3 request id: hex-ish
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export function xmlResponse(xml: string, status = 200, headers: Record<string, string> = {}): Response {
  const h = new Headers({
    "Content-Type": "application/xml",
    "x-amz-request-id": generateRequestId(),
    ...headers,
  });
  return new Response(xml, { status, headers: h });
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
export function s3Error(code: string, message: string, status: number, resource = "", requestId = generateRequestId()): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${escXml(code)}</Code><Message>${escXml(message)}</Message><Resource>${escXml(resource)}</Resource><RequestId>${escXml(requestId)}</RequestId></Error>`;
  return new Response(xml, {
    status,
    headers: { "Content-Type": "application/xml", "x-amz-request-id": requestId },
  });
}
