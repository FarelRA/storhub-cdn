import type { Env } from "../types";

export function parseBucketKey(url: URL, host: string, env: { BUCKET_REPOS?: string; CUSTOM_DOMAIN?: string }): { bucket: string | null; key: string } {
  let pathname: string;
  try {
    pathname = url.pathname.split("/").map(seg => { try { return decodeURIComponent(seg); } catch { return seg; } }).join("/");
  } catch { pathname = url.pathname; }
  const pathParts = pathname.replace(/^\/+/, "").split("/");
  let bucket: string | null = null;
  let key: string = "";
  const hostNoPort = host.split(":")[0].toLowerCase();
  const customDomain = (env as any).CUSTOM_DOMAIN ? String((env as any).CUSTOM_DOMAIN).toLowerCase().replace(/^https?:\/\//, "").split("/")[0] : null;
  let knownBuckets: string[] = [];
  if (env.BUCKET_REPOS) { try { knownBuckets = Object.keys(JSON.parse(env.BUCKET_REPOS)); } catch {} }
  const denyPrefixes = ["www", "api", "s3", "storhub"];
  const labels = hostNoPort.split(".");
  const possibleBucketFromHost = labels.length >= 2 ? labels[0] : null;
  const hostBucketCandidate = (() => {
    if (!possibleBucketFromHost || denyPrefixes.includes(possibleBucketFromHost)) return null;
    if (customDomain) { if (!hostNoPort.endsWith(customDomain)) return null; return possibleBucketFromHost; }
    if (knownBuckets.includes(possibleBucketFromHost)) return possibleBucketFromHost;
    return null;
  })();
  if (hostBucketCandidate) {
    if (customDomain || knownBuckets.includes(hostBucketCandidate)) {
      bucket = hostBucketCandidate; key = pathname.replace(/^\/+/, "");
    }
  } else if (possibleBucketFromHost && labels.length >= 3 && !hostNoPort.endsWith("workers.dev")) {
    const isWorkersDev = hostNoPort.endsWith("workers.dev");
    if (!isWorkersDev && possibleBucketFromHost && !denyPrefixes.includes(possibleBucketFromHost) && pathParts[0] !== possibleBucketFromHost) {
      if (knownBuckets.length === 0 || !knownBuckets.includes(pathParts[0])) { bucket = possibleBucketFromHost; key = pathname.replace(/^\/+/, ""); }
    }
  }
  if (!bucket) {
    if (!pathname || pathname === "/" || pathname === "") { bucket = null; key = ""; }
    else { bucket = pathParts[0] || null; key = pathParts.slice(1).join("/"); }
  }
  return { bucket, key };
}

export function parseRange(rangeHeader: string | null, total: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const m = rangeHeader.match(/bytes\s*=\s*(\d*)-(\d*)/i);
  if (!m) return null;
  let startStr = m[1]; let endStr = m[2]; let start: number, end: number;
  if (startStr === "" && endStr !== "") { const suffix = parseInt(endStr, 10); if (Number.isNaN(suffix)) return null; start = Math.max(0, total - suffix); end = total - 1; }
  else if (startStr !== "" && endStr === "") { start = parseInt(startStr, 10); end = total - 1; }
  else if (startStr !== "" && endStr !== "") { start = parseInt(startStr, 10); end = parseInt(endStr, 10); if (end >= total) end = total - 1; }
  else return null;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) return null;
  return { start, end };
}

export function parseAmzMeta(headers: Headers): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const [k, v] of headers.entries()) {
    const lk = k.toLowerCase();
    if (lk.startsWith("x-amz-meta-")) { const mk = lk.slice("x-amz-meta-".length); meta[mk] = v; }
  }
  return meta;
}
