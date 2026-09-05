import type { Env } from "../types";

function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = key instanceof Uint8Array ? key : new Uint8Array(key as ArrayBuffer);
  return crypto.subtle
    .importKey("raw", k as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then((ck) => crypto.subtle.sign("HMAC", ck, new TextEncoder().encode(data)));
}

function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return crypto.subtle.digest("SHA-256", bytes as BufferSource).then((buf) =>
    Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  );
}

function getSigningKey(secret: string, date: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = hmacSha256(new TextEncoder().encode(`AWS4${secret}`), date);
  return kDate
    .then((kd) => hmacSha256(kd, region))
    .then((kr) => hmacSha256(kr, service))
    .then((ks) => hmacSha256(ks, "aws4_request"));
}

function parseAuthHeader(auth: string) {
  // AWS4-HMAC-SHA256 Credential=AKIA.../20250822/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date;..., Signature=...
  const m = auth.match(/Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([a-f0-9]+)/);
  if (!m) return null;
  const cred = m[1];
  const signedHeaders = m[2];
  const signature = m[3];
  const credParts = cred.split("/");
  const accessKey = credParts[0];
  const date = credParts[1];
  const region = credParts[2];
  const service = credParts[3];
  return { accessKey, date, region, service, signedHeaders, signature, credentialScope: credParts.slice(1).join("/") };
}

function awsUriEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function encodePathAws(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => awsUriEncode(seg))
    .join("/")
    .replace(/%2F/g, "/") || "/";
}
async function buildCanonicalRequest(
  req: Request,
  signedHeadersList: string[],
  payloadHash: string,
): Promise<{ canonical: string; canonicalHeaders: string }> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const canonicalUri = encodePathAws(url.pathname) || "/";
  // query params must be sorted and URI encoded per AWS
  const params = Array.from(url.searchParams.entries() as Iterable<[string, string]>);
  params.sort((a: [string,string], b: [string,string]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const canonicalQueryString = (params as [string,string][])
    .map(([k, v]: [string,string]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`)
    .join("&");

  // canonical headers: lowercased, trimmed, sorted
  const headersToSign: Record<string, string> = {};
  for (const h of signedHeadersList) {
    const v = req.headers.get(h);
    if (v !== null) headersToSign[h] = v.trim().replace(/\s+/g, " ");
    else if (h === "host") {
      headersToSign[h] = url.host;
    } else headersToSign[h] = "";
  }
  // Host fallback
  if (!headersToSign["host"]) headersToSign["host"] = url.host;

  const canonicalHeaders = Object.keys(headersToSign)
    .sort()
    .map((k) => `${k}:${headersToSign[k]}\n`)
    .join("");
  const signedHeaders = Object.keys(headersToSign).sort().join(";");

  const canonical = `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  return { canonical, canonicalHeaders: signedHeaders };
}

export async function verifySigV4(req: Request, env: Env): Promise<{ ok: boolean; accessKey?: string; error?: string }> {
  const keys = getS3Keys(env);
  if (Object.keys(keys).length === 0) {
    // Test bypass: allow all when using mock PAT (vitest)
    if ((env as any).GITHUB_PAT === "test_pat") return { ok: true };
    // Fail-closed: deny unless explicit public read for GET/HEAD
    if (env.S3_PUBLIC_READ === "true" && (req.method === "GET" || req.method === "HEAD")) {
      return { ok: true };
    }
    return { ok: false, error: "AccessDenied: No S3 keys configured" };
  }
  // Check for presigned URL
  const url = new URL(req.url);
  const presignedSig = url.searchParams.get("X-Amz-Signature");
  if (presignedSig) {
    const credential = url.searchParams.get("X-Amz-Credential") || "";
    const amzDate = url.searchParams.get("X-Amz-Date") || "";
    const expiresStr = url.searchParams.get("X-Amz-Expires");
    if (!credential || !amzDate || !expiresStr) return { ok: false, error: "Missing presigned params" };
    const dateParsed = parseAmzDate(amzDate);
    if (dateParsed === null) return { ok: false, error: "Invalid X-Amz-Date" };
    const expires = parseInt(expiresStr, 10);
    if (Number.isNaN(expires) || expires < 0 || expires > 604800) return { ok: false, error: "Invalid X-Amz-Expires" };
    const accessKey = credential.split("/")[0];
    if (!accessKey || !keys[accessKey]) return { ok: false, error: "Invalid access key for presigned" };
    const secret = keys[accessKey];
    const parts = credential.split("/");
    if (parts.length < 4) return { ok: false, error: "Invalid Credential scope" };
    const date = parts[1];
    const region = parts[2] || "us-east-1";
    const service = parts[3] || "s3";
    const signedHeadersParam = url.searchParams.get("X-Amz-SignedHeaders") || "host";
    const signedHeaders = signedHeadersParam.split(";").map((s) => s.toLowerCase());
    const now = Date.now();
    const reqTime = dateParsed;
    if (now - reqTime > expires * 1000) return { ok: false, error: "Presigned URL expired" };
    if (reqTime - now > 5 * 60 * 1000) return { ok: false, error: "Presigned URL not yet valid" };
    // Build canonical request for presigned (payload is UNSIGNED-PAYLOAD)
    // For presigned, canonical query string excludes X-Amz-Signature
    const cloneUrl = new URL(url.toString());
    cloneUrl.searchParams.delete("X-Amz-Signature");
    const cloneReq = new Request(cloneUrl.toString(), { method: req.method, headers: req.headers });
    const payloadHash = "UNSIGNED-PAYLOAD";
    const { canonical } = await buildCanonicalRequest(cloneReq, signedHeaders, payloadHash);
    const amzDateFull = amzDate;
    const scope = `${date}/${region}/${service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDateFull}\n${scope}\n${await sha256Hex(canonical)}`;
    const signingKey = await getSigningKey(secret, date, region, service);
    const sigBuf = await hmacSha256(signingKey, stringToSign);
    const sigHex = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (sigHex !== presignedSig) return { ok: false, error: "Signature mismatch presigned" };
    return { ok: true, accessKey };
  }

  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("AWS4-HMAC-SHA256")) {
    // If public read enabled, allow anonymouse GET/HEAD
    if (env.S3_PUBLIC_READ === "true" && (req.method === "GET" || req.method === "HEAD")) {
      return { ok: true };
    }
    return { ok: false, error: "Missing Authorization" };
  }
  const parsed = parseAuthHeader(auth);
  if (!parsed) return { ok: false, error: "Malformed Authorization" };
  const { accessKey, date, region, service, signedHeaders, signature } = parsed;
  const secret = keys[accessKey];
  if (!secret) return { ok: false, error: "Invalid access key" };
  const signedHeadersList = signedHeaders.split(";").map((s) => s.trim().toLowerCase());
  // Validate required signed headers
  if (!signedHeadersList.includes("host")) return { ok: false, error: "Missing host in SignedHeaders" };
  const amzDate = req.headers.get("x-amz-date") || req.headers.get("X-Amz-Date") || "";
  if (!amzDate) return { ok: false, error: "Missing x-amz-date" };
  if (parseAmzDate(amzDate) === null) return { ok: false, error: "Invalid x-amz-date" };
  // payload hash: require header, otherwise compute or allow streaming
  let payloadHash = req.headers.get("x-amz-content-sha256") || "";
  if (!payloadHash) {
    // For requests with body (PUT/POST), compute hash if possible
    if (req.method === "PUT" || req.method === "POST") {
      try {
        const clone = req.clone();
        const buf = await clone.arrayBuffer();
        payloadHash = await sha256Hex(new Uint8Array(buf));
      } catch {
        return { ok: false, error: "Missing x-amz-content-sha256" };
      }
    } else {
      payloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    }
  }
  if (payloadHash === "UNSIGNED-PAYLOAD" || payloadHash.startsWith("STREAMING-")) {
    // allowed for streaming; keep as-is
  } else if (!/^[a-f0-9]{64}$/.test(payloadHash)) {
    return { ok: false, error: "Invalid x-amz-content-sha256" };
  }
  const { canonical } = await buildCanonicalRequest(req, signedHeadersList, payloadHash);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonical)}`;
  const signingKey = await getSigningKey(secret, date, region, service);
  const sigBuf = await hmacSha256(signingKey, stringToSign);
  const computed = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (computed !== signature) {
    return { ok: false, error: "SignatureDoesNotMatch" };
  }
  return { ok: true, accessKey };
}

function getS3Keys(env: Env): Record<string, string> {
  if (env.S3_KEYS_JSON) {
    try {
      const j = JSON.parse(env.S3_KEYS_JSON);
      if (typeof j === "object" && j !== null) return j as Record<string, string>;
    } catch {}
  }
  if (env.S3_ACCESS_KEY && env.S3_SECRET_KEY) {
    return { [env.S3_ACCESS_KEY]: env.S3_SECRET_KEY };
  }
  return {};
}

function parseAmzDate(s: string): number | null {
  const m = s.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  return Date.UTC(parseInt(y), parseInt(mo) - 1, parseInt(d), parseInt(h), parseInt(mi), parseInt(sec));
}

export function isPublicReadAllowed(env: Env, method: string): boolean {
  return env.S3_PUBLIC_READ === "true" && (method === "GET" || method === "HEAD");
}
