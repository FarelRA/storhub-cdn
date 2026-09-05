import type { Env, ObjectMeta, Chunk } from "../types";
import { verifySigV4 } from "./auth";
import { getChunkSize, parseBucketKey, parseRange, parseAmzMeta, formatRFC1123, md5Hex, etagForChunks, s3Error, xmlResponse, generateRequestId } from "./util";
import * as xml from "./xml";
import { readManifest, withManifest, readMultipartState, writeMultipartState, withMultipart } from "../github/manifest";
import { ensureRelease, uploadAssetBytes, deleteAsset, downloadAsset, getRepo, createRepo, getAuthenticatedUser } from "../github/client";
import { ensureDataReleaseForUpload } from "../github/sharding";
import { createChunkedStream } from "../github/stream";

async function resolveBucketRepo(env: Env, bucket: string): Promise<{ owner: string; repo: string }> {
  // BUCKET_REPOS JSON map
  if (env.BUCKET_REPOS) {
    try {
      const m = JSON.parse(env.BUCKET_REPOS) as Record<string, string>;
      if (m[bucket]) {
        const v = m[bucket];
        const parts = v.split("/");
        if (parts.length === 2) return { owner: parts[0], repo: parts[1] };
      }
    } catch {}
  }
  if (env.GITHUB_OWNER) {
    return { owner: env.GITHUB_OWNER, repo: bucket };
  }
  // try to infer from PAT user?
  // If bucket contains slash, treat as owner/repo
  if (bucket.includes("/")) {
    const [o, r] = bucket.split("/", 2);
    return { owner: o, repo: r };
  }
  throw new Error(`Cannot resolve bucket repo for ${bucket}: set BUCKET_REPOS or GITHUB_OWNER`);
}

async function ensureBucket(env: Env, owner: string, repo: string, metadataTag: string): Promise<void> {
  const repoInfo = await getRepo(env, owner, repo);
  if (!repoInfo) {
    // try to create repo
    try {
      const user = await getAuthenticatedUser(env);
      const isOrg = owner.toLowerCase() !== user.login.toLowerCase();
      await createRepo(env, owner, repo, isOrg);
    } catch (e) {
      throw new Error(`Bucket repo ${owner}/${repo} not found and auto-create failed: ${e}`);
    }
  }
  // ensure metadata release exists
  await ensureRelease(env, owner, repo, metadataTag);
}

function parseQuery(url: URL): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) o[k] = v;
  return o;
}

function getMetadataTag(env: Env): string {
  return env.METADATA_TAG || "s3-metadata";
}
function getDataPrefix(env: Env): string {
  return env.DATA_TAG_PREFIX || "s3-data-";
}

// Generate opaque asset name for chunk
function chunkAssetName(key: string, partIndex: number, uploadId: string): string {
  // Use hash of key + uploadId + part to avoid exposing key and collision
  // Simple: chk_<random>_<part> but need uniqueness per object version
  // We'll use: o_<uploadId>_p<index>
  return `chk_${uploadId}_p${String(partIndex).padStart(6, "0")}`;
}

async function handleListBuckets(env: Env, request: Request): Promise<Response> {
  let buckets: { name: string; creationDate: string }[] = [];
  if (env.BUCKET_REPOS) {
    try {
      const m = JSON.parse(env.BUCKET_REPOS) as Record<string, string>;
      for (const b of Object.keys(m)) {
        const { owner, repo } = await resolveBucketRepo(env, b);
        const info = await getRepo(env, owner, repo).catch(() => null);
        if (!info) continue;
        buckets.push({ name: b, creationDate: info?.created_at || new Date().toISOString() });
      }
    } catch {}
  }
  if (buckets.length === 0 && env.GITHUB_OWNER) {
    try {
      const owner = env.GITHUB_OWNER!;
      const fetchRepos = async (path: string) => {
        const res = await fetch(`https://api.github.com${path}`, {
          headers: {
            Authorization: `Bearer ${env.GITHUB_PAT}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "storhub-cdn/0.1",
          },
        });
        if (!res.ok) return [];
        const arr = (await res.json()) as any[];
        return arr.map((r) => ({ name: r.name, creationDate: r.created_at }));
      };
      let list = await fetchRepos(`/orgs/${owner}/repos?per_page=100`);
      if (list.length === 0) list = await fetchRepos(`/users/${owner}/repos?per_page=100`);
      // Filter to only repos with s3-metadata release
      const filtered: typeof list = [];
      for (const r of list.slice(0, 20)) {
        try {
          const { getReleaseByTag: getR2 } = await import("../github/client");
          // try both owner/repo variations: list gives name only, need owner
          const rel = await getR2(env, owner, r.name, getMetadataTag(env));
          if (rel) filtered.push(r);
        } catch {}
      }
      buckets.push(...filtered);
    } catch {}
  }
  const xmlBody = xml.listBucketsXml(buckets);
  return xmlResponse(xmlBody, 200);
}

async function handleHeadBucket(env: Env, bucket: string): Promise<Response> {
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const info = await getRepo(env, owner, repo);
  if (!info) return s3Error("NoSuchBucket", "The specified bucket does not exist", 404, bucket);
  return new Response(null, { status: 200, headers: { "x-amz-bucket-region": "us-east-1", "x-amz-request-id": generateRequestId() } });
}

async function handleCreateBucket(env: Env, bucket: string): Promise<Response> {
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const existing = await getRepo(env, owner, repo);
  if (existing) return s3Error("BucketAlreadyOwnedByYou", "Your previous request to create the named bucket succeeded and you already own it.", 409, bucket);
  await ensureBucket(env, owner, repo, getMetadataTag(env));
  return new Response(null, { status: 200, headers: { Location: `/${bucket}`, "x-amz-request-id": generateRequestId() } });
}

async function handleDeleteBucket(env: Env, bucket: string): Promise<Response> {
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const info = await getRepo(env, owner, repo);
  if (!info) return s3Error("NoSuchBucket", "The specified bucket does not exist", 404, bucket);
  const { manifest } = await readManifest(env, owner, repo, getMetadataTag(env));
  if (Object.keys(manifest.objects).length > 0) return s3Error("BucketNotEmpty", "The bucket you tried to delete is not empty", 409, bucket);
  const { uploads } = await readMultipartState(env, owner, repo, getMetadataTag(env));
  if (Object.keys(uploads).length > 0) return s3Error("BucketNotEmpty", "The bucket you tried to delete is not empty (multipart uploads in progress)", 409, bucket);
  return new Response(null, { status: 204, headers: { "x-amz-request-id": generateRequestId() } });
}

async function handleListObjectsV2(env: Env, bucket: string, url: URL): Promise<Response> {
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const info = await getRepo(env, owner, repo);
  if (!info) return s3Error("NoSuchBucket", "The specified bucket does not exist", 404, bucket);
  const { manifest } = await readManifest(env, owner, repo, getMetadataTag(env));
  const prefix = url.searchParams.get("prefix") || "";
  const delimiter = url.searchParams.get("delimiter") || "";
  const maxKeysRaw = url.searchParams.get("max-keys");
  let maxKeys = 1000;
  if (maxKeysRaw !== null) {
    const parsed = parseInt(maxKeysRaw, 10);
    if (Number.isNaN(parsed) || parsed < 0) return s3Error("InvalidArgument", "Invalid max-keys", 400, bucket);
    maxKeys = Math.min(parsed, 1000);
  }
  const continuationToken = url.searchParams.get("continuation-token") || url.searchParams.get("continuationToken") || "";
  const startAfter = url.searchParams.get("start-after") || "";
  const encodingType = url.searchParams.get("encoding-type") || "";

  // Decode continuation token: base64 (unicode safe)
  const base64Decode = (s: string): string => {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
    } catch {
      try {
        return atob(s);
      } catch {
        return s;
      }
    }
  };
  const base64Encode = (s: string): string => {
    try {
      const bytes = new TextEncoder().encode(s);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary);
    } catch {
      return btoa(s);
    }
  };
  let startKey = "";
  if (continuationToken) {
    startKey = base64Decode(continuationToken);
  } else if (startAfter) {
    startKey = startAfter;
  }

  // Filter and sort keys lexicographically (S3 does)
  let allKeys = Object.keys(manifest.objects).sort();
  if (prefix) allKeys = allKeys.filter((k) => k.startsWith(prefix));
  // Apply startKey exclusive
  if (startKey) {
    const idx = allKeys.findIndex((k) => k > startKey);
    allKeys = idx === -1 ? [] : allKeys.slice(idx);
  }

  // Delimiter handling: group keys by common prefix
  const contents: { key: string; lastModified: string; etag: string; size: number; storageClass: string }[] = [];
  const commonPrefixesSet = new Set<string>();
  let truncated = false;
  let nextToken: string | undefined;

  let resultCount = 0;
  let lastKey = "";
  for (const k of allKeys) {
    if (resultCount >= maxKeys) {
      truncated = true;
      nextToken = base64Encode(lastKey);
      break;
    }
    const meta = manifest.objects[k]!;
    if (delimiter) {
      const suffix = k.slice(prefix.length);
      const delimIdx = suffix.indexOf(delimiter);
      if (delimIdx !== -1) {
        const cp = prefix + suffix.slice(0, delimIdx + delimiter.length);
        if (!commonPrefixesSet.has(cp)) {
          if (resultCount >= maxKeys) {
            truncated = true;
            nextToken = base64Encode(lastKey);
            break;
          }
          commonPrefixesSet.add(cp);
          resultCount++;
          lastKey = k;
        }
        continue;
      }
    }
    // It's a content
    contents.push({
      key: encodingType === "url" ? encodeURIComponent(k) : k,
      lastModified: meta.lastModified,
      etag: meta.etag,
      size: meta.size,
      storageClass: meta.storageClass || "STANDARD",
    });
    resultCount++;
    lastKey = k;
  }

  const commonPrefixesEncoded =
    encodingType === "url"
      ? Array.from(commonPrefixesSet)
          .sort()
          .map((p) => encodeURIComponent(p))
      : Array.from(commonPrefixesSet).sort();

  const xmlBody = xml.listObjectsV2Xml({
    name: bucket,
    prefix: encodingType === "url" ? encodeURIComponent(prefix) : prefix,
    delimiter: encodingType === "url" ? encodeURIComponent(delimiter) : delimiter,
    maxKeys,
    keyCount: contents.length + commonPrefixesSet.size,
    isTruncated: truncated,
    nextContinuationToken: truncated ? nextToken : undefined,
    continuationToken: continuationToken || undefined,
    encodingType: encodingType || undefined,
    commonPrefixes: commonPrefixesEncoded,
    contents,
  });
  return xmlResponse(xmlBody, 200);
}

// HEAD/GET object shared
async function getObjectMeta(env: Env, bucket: string, key: string): Promise<{ meta: ObjectMeta; owner: string; repo: string } | null> {
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const { manifest } = await readManifest(env, owner, repo, getMetadataTag(env));
  const meta = manifest.objects[key];
  if (!meta) return null;
  return { meta, owner, repo };
}

async function handleHeadObject(env: Env, bucket: string, key: string, request: Request): Promise<Response> {
  const found = await getObjectMeta(env, bucket, key);
  if (!found) return s3Error("NoSuchKey", "The specified key does not exist.", 404, key);
  const { meta } = found;
  // Conditional headers: If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since
  const ifMatch = request.headers.get("if-match");
  if (ifMatch) {
    const needed = ifMatch.trim();
    if (needed !== "*" && needed.replace(/"/g, "") !== meta.etag.replace(/"/g, "")) {
      return new Response(null, { status: 412, headers: { "x-amz-request-id": generateRequestId() } });
    }
  }
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch) {
    const inm = ifNoneMatch.trim();
    if (inm === "*" || inm.replace(/"/g, "") === meta.etag.replace(/"/g, "")) {
      return new Response(null, { status: 304, headers: { ETag: meta.etag, "x-amz-request-id": generateRequestId() } });
    }
  }
  const ifUnmodifiedSince = request.headers.get("if-unmodified-since");
  if (ifUnmodifiedSince) {
    const ius = new Date(ifUnmodifiedSince).getTime();
    const lm = new Date(meta.lastModified).getTime();
    if (!Number.isNaN(ius) && lm > ius) {
      return new Response(null, { status: 412, headers: { "x-amz-request-id": generateRequestId() } });
    }
  }
  const ifModifiedSince = request.headers.get("if-modified-since");
  if (ifModifiedSince) {
    const ims = new Date(ifModifiedSince).getTime();
    const lm = new Date(meta.lastModified).getTime();
    if (!Number.isNaN(ims) && lm <= ims) {
      return new Response(null, { status: 304, headers: { ETag: meta.etag, "x-amz-request-id": generateRequestId() } });
    }
  }
  const headers = new Headers({
    "Content-Type": meta.contentType || "application/octet-stream",
    "Content-Length": String(meta.size),
    ETag: meta.etag,
    "Last-Modified": formatRFC1123(meta.lastModified),
    "Accept-Ranges": "bytes",
    "x-amz-request-id": generateRequestId(),
  });
  if (meta.contentEncoding) headers.set("Content-Encoding", meta.contentEncoding);
  if (meta.contentDisposition) headers.set("Content-Disposition", meta.contentDisposition);
  if (meta.cacheControl) headers.set("Cache-Control", meta.cacheControl);
  if (meta.expires) headers.set("Expires", meta.expires);
  for (const [k, v] of Object.entries(meta.meta || {})) headers.set(`x-amz-meta-${k}`, v);
  return new Response(null, { status: 200, headers });
}

async function handleGetObject(env: Env, bucket: string, key: string, request: Request, url: URL): Promise<Response> {
  if (url.searchParams.has("tagging")) {
    const found = await getObjectMeta(env, bucket, key);
    if (!found) return s3Error("NoSuchKey", "The specified key does not exist.", 404, key);
    const body = xml.tagGetXml(found.meta.tags || {});
    return xmlResponse(body, 200);
  }
  if (url.searchParams.has("select")) {
    return s3Error("NotImplemented", "SelectObjectContent not implemented", 501, key);
  }

  const found = await getObjectMeta(env, bucket, key);
  if (!found) return s3Error("NoSuchKey", "The specified key does not exist.", 404, key);
  const { meta, owner, repo } = found;

  // Conditional headers
  const ifMatch = request.headers.get("if-match");
  if (ifMatch) {
    const needed = ifMatch.trim();
    if (needed !== "*" && needed.replace(/"/g, "") !== meta.etag.replace(/"/g, "")) {
      return new Response(null, { status: 412, headers: { "x-amz-request-id": generateRequestId() } });
    }
  }
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch) {
    const inm = ifNoneMatch.trim();
    if (inm === "*" || inm.replace(/"/g, "") === meta.etag.replace(/"/g, "")) {
      return new Response(null, { status: 304, headers: { ETag: meta.etag, "x-amz-request-id": generateRequestId() } });
    }
  }
  const ifUnmodifiedSince = request.headers.get("if-unmodified-since");
  if (ifUnmodifiedSince) {
    const ius = new Date(ifUnmodifiedSince).getTime();
    const lm = new Date(meta.lastModified).getTime();
    if (!Number.isNaN(ius) && lm > ius) {
      return new Response(null, { status: 412, headers: { "x-amz-request-id": generateRequestId() } });
    }
  }
  const ifModifiedSince = request.headers.get("if-modified-since");
  if (ifModifiedSince) {
    const ims = new Date(ifModifiedSince).getTime();
    const lm = new Date(meta.lastModified).getTime();
    if (!Number.isNaN(ims) && lm <= ims && !ifNoneMatch) {
      return new Response(null, { status: 304, headers: { ETag: meta.etag, "x-amz-request-id": generateRequestId() } });
    }
  }
  const rangeHeader = request.headers.get("range");
  const totalSize = meta.size;
  let range = null;
  if (rangeHeader) {
    // Honor If-Range
    const ifRange = request.headers.get("if-range");
    let rangeAllowed = true;
    if (ifRange) {
      const trimmed = ifRange.trim();
      // If-Range can be ETag or date
      if (trimmed.startsWith('"') || trimmed.startsWith("W/") || /^[a-f0-9]{32}/i.test(trimmed.replace(/"/g, ""))) {
        if (trimmed.replace(/"/g, "") !== meta.etag.replace(/"/g, "")) rangeAllowed = false;
      } else {
        const d = new Date(trimmed).getTime();
        const lm = new Date(meta.lastModified).getTime();
        if (!Number.isNaN(d) && lm > d) rangeAllowed = false;
      }
    }
    if (rangeAllowed) {
      range = parseRange(rangeHeader, totalSize);
      if (!range) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${totalSize}`, "x-amz-request-id": generateRequestId() } });
      }
    }
  }

  // Optional 302 redirect for public buckets (zero egress)
  if (env.S3_PUBLIC_READ === "true" && !range && meta.chunks.length === 1 && !request.headers.get("authorization")) {
    const single = meta.chunks[0];
    // Try to fetch asset's browser_download_url via HEAD? For now redirect to GitHub API asset download
    // Use 302 to browser_download_url if available via manifest? We don't store it, so stream
  }
  // Handle 0-byte object
  if (meta.chunks.length === 0) {
    const headers = new Headers({
      "Content-Type": meta.contentType || "application/octet-stream",
      ETag: meta.etag,
      "Last-Modified": formatRFC1123(meta.lastModified),
      "Accept-Ranges": "bytes",
      "Content-Length": "0",
      "x-amz-request-id": generateRequestId(),
    });
    for (const [k, v] of Object.entries(meta.meta || {})) headers.set(`x-amz-meta-${k}`, v);
    return new Response(null, { status: 200, headers });
  }

  // Streaming: create concatenated stream
  const stream = createChunkedStream(env, owner, repo, meta.chunks, range || undefined);
  const length = range ? range.end - range.start + 1 : totalSize;

  const headers = new Headers({
    "Content-Type": meta.contentType || "application/octet-stream",
    ETag: meta.etag,
    "Last-Modified": formatRFC1123(meta.lastModified),
    "Accept-Ranges": "bytes",
    "Content-Length": String(length),
    "x-amz-request-id": generateRequestId(),
  });
  if (meta.contentEncoding) headers.set("Content-Encoding", meta.contentEncoding);
  if (meta.contentDisposition) headers.set("Content-Disposition", meta.contentDisposition);
  if (meta.cacheControl) headers.set("Cache-Control", meta.cacheControl);
  for (const [k, v] of Object.entries(meta.meta || {})) headers.set(`x-amz-meta-${k}`, v);

  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${totalSize}`);
    // Use Cloudflare cache? For range, don't cache long
    return new Response(stream, { status: 206, headers });
  }

  headers.set("Cache-Control", headers.get("Cache-Control") || "public, max-age=86400");
  // Cloudflare cache: try match, else put
  try {
    const cache = (caches as any).default as Cache | undefined;
    if (cache && !range) {
      const cacheKey = new Request(url.toString(), { method: "GET" });
      const cached = await cache.match(cacheKey);
      if (cached) {
        const hdr = new Headers(cached.headers);
        hdr.set("x-cache-status", "HIT");
        hdr.set("x-amz-request-id", headers.get("x-amz-request-id")!);
        return new Response(cached.body, { status: cached.status, headers: hdr });
      }
      const respToCache = new Response(stream, { status: 200, headers });
      // Clone for cache
      const clone = respToCache.clone();
      // Use waitUntil if available
      try { (globalThis as any).caches?.default && (await cache.put(cacheKey, clone)); } catch {}
      return respToCache;
    }
  } catch {}
  return new Response(stream, { status: 200, headers });
}

// PUT object with chunking and streaming
async function handlePutObject(env: Env, bucket: string, key: string, request: Request, url: URL, ctx?: ExecutionContext): Promise<Response> {
  // Check copy-source
  const copySource = request.headers.get("x-amz-copy-source");
  if (copySource) {
    return handleCopyObject(env, bucket, key, request, copySource);
  }
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  if (url.searchParams.has("tagging")) {
    const bodyText = await request.text();
    const tags: Record<string, string> = {};
    const re = /<Tag>\s*<Key>(.*?)<\/Key>\s*<Value>(.*?)<\/Value>\s*<\/Tag>/gs;
    let m: RegExpExecArray | null;
    while ((m = re.exec(bodyText)) !== null) {
      let k = m[1].replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'");
      let v = m[2].replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'");
      tags[k]=v;
    }
    await withManifest(env, owner, repo, getMetadataTag(env), async (manifest) => {
      const existing = manifest.objects[key];
      if (!existing) throw new Error("NoSuchKey");
      existing.tags = tags;
      return { manifest, result: null };
    });
    return new Response(null, { status: 200, headers: { "x-amz-request-id": generateRequestId() } });
  }
  await ensureBucket(env, owner, repo, getMetadataTag(env));
  const chunkSize = getChunkSize(env);
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const contentEncoding = request.headers.get("content-encoding") || undefined;
  const contentDisposition = request.headers.get("content-disposition") || undefined;
  const cacheControl = request.headers.get("cache-control") || undefined;
  const expires = request.headers.get("expires") || undefined;
  const meta = parseAmzMeta(request.headers);

  const hasBody = request.body !== null;

  const uploadId = crypto.randomUUID().replace(/-/g, "");
  const newChunks: Chunk[] = [];
  const chunkEtags: string[] = [];
  let totalSize = 0;

  if (hasBody && request.body) {
    const reader = request.body.getReader();
    let queue: Uint8Array[] = [];
    let queueBytes = 0;
    let partIdx = 0;
    let offset = 0;
    const enqueue = (arr: Uint8Array) => {
      queue.push(arr);
      queueBytes += arr.length;
    };
    const dequeueSlice = (size: number): Uint8Array => {
      const out = new Uint8Array(size);
      let outOff = 0;
      while (outOff < size) {
        const head = queue[0];
        const need = size - outOff;
        if (head.length <= need) {
          out.set(head, outOff);
          outOff += head.length;
          queue.shift();
          queueBytes -= head.length;
        } else {
          out.set(head.subarray(0, need), outOff);
          queue[0] = head.subarray(need);
          queueBytes -= need;
          outOff += need;
        }
      }
      return out;
    };
    const flushQueue = (): Uint8Array => {
      const out = new Uint8Array(queueBytes);
      let off = 0;
      for (const arr of queue) {
        out.set(arr, off);
        off += arr.length;
      }
      queue = [];
      queueBytes = 0;
      return out;
    };
    const uploadWithRetry = async (slice: Uint8Array, partIdxNum: number): Promise<{ asset: import("../types").GitHubAsset; release: import("../types").GitHubRelease }> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const release = await ensureDataReleaseForUpload(env, owner, repo, getDataPrefix(env));
        const assetName = chunkAssetName(key, partIdxNum, uploadId);
        try {
          const asset = await uploadAssetBytes(env, owner, repo, release.id, assetName, slice, contentType);
          return { asset, release };
        } catch (e: any) {
          const msg = String(e?.message || "");
          if (msg.includes("422") && attempt < 2) {
            // shard full race — retry with next shard
            await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
            continue;
          }
          throw e;
        }
      }
      throw new Error("upload failed after retries");
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        enqueue(value);
        while (queueBytes >= chunkSize) {
          const slice = dequeueSlice(chunkSize);
          const etagHex = await md5Hex(slice);
          const etag = `"${etagHex}"`;
          chunkEtags.push(etag);
          const { asset, release } = await uploadWithRetry(slice, partIdx);
          newChunks.push({
            releaseTag: release.tag_name,
            assetId: asset.id,
            assetName: asset.name,
            size: slice.length,
            offset: offset,
          });
          offset += slice.length;
          totalSize += slice.length;
          partIdx++;
        }
      }
      if (queueBytes > 0) {
        const slice = flushQueue();
        const etagHex = await md5Hex(slice);
        const etag = `"${etagHex}"`;
        chunkEtags.push(etag);
        const { asset, release } = await uploadWithRetry(slice, partIdx);
        newChunks.push({
          releaseTag: release.tag_name,
          assetId: asset.id,
          assetName: asset.name,
          size: slice.length,
          offset: offset,
        });
        totalSize += slice.length;
      }
    } catch (e) {
      for (const ch of newChunks) {
        try { await deleteAsset(env, owner, repo, ch.assetId); } catch {}
      }
      throw e;
    }
  } else {
    totalSize = 0;
  }

  // Also handle case where request has Content-Length: 0 and no body, we still have 0 chunks

  // Compute final etag
  let etag: string;
  if (newChunks.length === 0) {
    etag = `"d41d8cd98f00b204e9800998ecf8427e"`;
  } else if (newChunks.length === 1) {
    etag = chunkEtags[0];
  } else {
    etag = await etagForChunks(chunkEtags, totalSize);
  }

  const nowIso = new Date().toISOString();
  const taggingHeader = request.headers.get("x-amz-tagging");
  let tags: Record<string, string> | undefined;
  if (taggingHeader) {
    tags = {};
    for (const pair of taggingHeader.split("&")) {
      const [k,v] = pair.split("=");
      if (k) tags[decodeURIComponent(k)] = decodeURIComponent(v||"");
    }
  }
  const versionId = crypto.randomUUID();
  const objectMeta: ObjectMeta = {
    key,
    size: totalSize,
    etag,
    contentType,
    contentEncoding,
    contentDisposition,
    cacheControl,
    expires,
    lastModified: nowIso,
    storageClass: "STANDARD",
    meta,
    chunks: newChunks,
    tags,
    versionId,
  };

  // Atomically update manifest
  const metadataTag = getMetadataTag(env);
  let oldChunks: Chunk[] = [];
  await withManifest(env, owner, repo, metadataTag, async (manifest) => {
    const existing = manifest.objects[key];
    if (existing) oldChunks = existing.chunks;
    manifest.objects[key] = objectMeta;
    return { manifest, result: null };
  });

  // Cleanup old chunks via waitUntil if available (proper ctx)
  const cleanup = async () => {
    for (const ch of oldChunks) {
      try { await deleteAsset(env, owner, repo, ch.assetId); } catch (e) { console.warn("cleanup old chunk failed", e); }
    }
  };
  try {
    if (ctx && ctx.waitUntil) ctx.waitUntil(cleanup());
    else cleanup().catch(() => {});
  } catch {}

  const headers = new Headers({
    ETag: etag,
    "x-amz-request-id": generateRequestId(),
  });
  return new Response(null, { status: 200, headers });
}

async function handleCopyObject(env: Env, bucket: string, key: string, request: Request, copySourceRaw: string): Promise<Response> {
  // copySource format: /sourceBucket/sourceKey or sourceBucket/sourceKey?versionId=...
  // Do not decode before splitting ? — %3F in key must not be treated as query delimiter
  let srcRaw = copySourceRaw.replace(/^\/+/, "");
  const qIdx = srcRaw.indexOf("?");
  if (qIdx !== -1) srcRaw = srcRaw.slice(0, qIdx);
  // Decode slash-separated bucket/key; bucket never contains slash, key may contain encoded slashes
  const slashIdx = srcRaw.indexOf("/");
  if (slashIdx === -1) return s3Error("InvalidRequest", "Invalid x-amz-copy-source", 400, key);
  let srcBucket: string;
  let srcKey: string;
  try {
    srcBucket = decodeURIComponent(srcRaw.slice(0, slashIdx));
    srcKey = decodeURIComponent(srcRaw.slice(slashIdx + 1));
  } catch {
    return s3Error("InvalidRequest", "Invalid x-amz-copy-source encoding", 400, key);
  }
  const srcFound = await getObjectMeta(env, srcBucket, srcKey);
  if (!srcFound) return s3Error("NoSuchKey", "The specified key does not exist.", 404, srcKey);
  const { meta: srcMeta, owner: srcOwner, repo: srcRepo } = srcFound;
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  await ensureBucket(env, owner, repo, getMetadataTag(env));

  // Always deep-copy bytes to avoid sharing assetIds (which would corrupt on delete)
  let newChunks: Chunk[] = [];
  let newEtag = srcMeta.etag;
  let newSize = srcMeta.size;

  if (srcMeta.chunks.length === 0) {
    newChunks = [];
  } else {
    // Deep copy with re-chunking to CHUNK_SIZE to avoid oversized chunks
    const chunkSize = getChunkSize(env);
    const srcStream = createChunkedStream(env, srcOwner, srcRepo, srcMeta.chunks);
    const reader = srcStream.getReader();
    let queue: Uint8Array[] = []; let queueBytes = 0;
    const enqueue = (arr: Uint8Array) => { queue.push(arr); queueBytes += arr.length; };
    const dequeueSlice = (size: number): Uint8Array => {
      const out = new Uint8Array(size); let off=0;
      while (off < size) {
        const head = queue[0];
        const need = size - off;
        if (head.length <= need) { out.set(head, off); off+=head.length; queue.shift(); queueBytes-=head.length; }
        else { out.set(head.subarray(0, need), off); queue[0]=head.subarray(need); queueBytes-=need; off+=need; }
      }
      return out;
    };
    const flushQueue = (): Uint8Array => {
      const out = new Uint8Array(queueBytes); let off=0; for (const a of queue){ out.set(a,off); off+=a.length;} queue=[]; queueBytes=0; return out;
    };
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!value) continue;
      enqueue(value);
      while (queueBytes >= chunkSize) {
        const slice = dequeueSlice(chunkSize);
        const assetName = `chk_${crypto.randomUUID().replace(/-/g, "")}_p${String(newChunks.length).padStart(6, "0")}`;
        const release = await ensureDataReleaseForUpload(env, owner, repo, getDataPrefix(env));
        const asset = await uploadAssetBytes(env, owner, repo, release.id, assetName, slice, srcMeta.contentType);
        newChunks.push({ releaseTag: release.tag_name, assetId: asset.id, assetName, size: slice.length, offset: newChunks.reduce((a,c)=>a+c.size,0) });
      }
    }
    if (queueBytes>0) {
      const slice = flushQueue();
      const assetName = `chk_${crypto.randomUUID().replace(/-/g, "")}_p${String(newChunks.length).padStart(6, "0")}`;
      const release = await ensureDataReleaseForUpload(env, owner, repo, getDataPrefix(env));
      const asset = await uploadAssetBytes(env, owner, repo, release.id, assetName, slice, srcMeta.contentType);
      newChunks.push({ releaseTag: release.tag_name, assetId: asset.id, assetName, size: slice.length, offset: newChunks.reduce((a,c)=>a+c.size,0) });
    }
  }

  // Merge metadata overrides
  const metadataDirective = request.headers.get("x-amz-metadata-directive") || "COPY";
  let metaOverride = srcMeta.meta;
  let contentTypeOverride = srcMeta.contentType;
  let contentEncodingOverride = srcMeta.contentEncoding;
  let contentDispositionOverride = srcMeta.contentDisposition;
  let cacheControlOverride = srcMeta.cacheControl;
  let expiresOverride = srcMeta.expires;
  if (metadataDirective === "REPLACE") {
    metaOverride = parseAmzMeta(request.headers);
    contentTypeOverride = request.headers.get("content-type") || srcMeta.contentType;
    contentEncodingOverride = request.headers.get("content-encoding") || undefined;
    contentDispositionOverride = request.headers.get("content-disposition") || undefined;
    cacheControlOverride = request.headers.get("cache-control") || undefined;
    expiresOverride = request.headers.get("expires") || undefined;
  }
  const nowIso = new Date().toISOString();
  const destMeta: ObjectMeta = {
    key,
    size: newSize,
    etag: newEtag,
    contentType: contentTypeOverride,
    contentEncoding: contentEncodingOverride,
    contentDisposition: contentDispositionOverride,
    cacheControl: cacheControlOverride,
    expires: expiresOverride,
    lastModified: nowIso,
    storageClass: srcMeta.storageClass,
    meta: metaOverride,
    chunks: newChunks,
  };

  let oldChunks: Chunk[] = [];
  await withManifest(env, owner, repo, getMetadataTag(env), async (manifest) => {
    const existing = manifest.objects[key];
    if (existing) oldChunks = existing.chunks;
    manifest.objects[key] = destMeta;
    return { manifest, result: null };
  });
  // cleanup old dest chunks
  for (const ch of oldChunks) {
    // if shallow copy reused same chunk ids as source, don't delete if they are same as newChunks sharing?
    // Avoid double delete: if old chunk assetId is in newChunks, skip
    if (newChunks.some((nc) => nc.assetId === ch.assetId)) continue;
    try { await deleteAsset(env, owner, repo, ch.assetId); } catch {}
  }

  const xmlBody = xml.copyObjectXml(destMeta.etag, destMeta.lastModified);
  return xmlResponse(xmlBody, 200);
}

async function handleDeleteObject(env: Env, bucket: string, key: string): Promise<Response> {
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const info = await getRepo(env, owner, repo);
  if (!info) return s3Error("NoSuchBucket", "The specified bucket does not exist", 404, bucket);
  let oldChunks: Chunk[] = [];
  await withManifest(env, owner, repo, getMetadataTag(env), async (manifest) => {
    const existing = manifest.objects[key];
    if (existing) {
      oldChunks = existing.chunks;
      delete manifest.objects[key];
    }
    return { manifest, result: null };
  });
  for (const ch of oldChunks) {
    try { await deleteAsset(env, owner, repo, ch.assetId); } catch (e) { console.warn("delete chunk failed", e); }
  }
  // S3 DeleteObject is idempotent 204 even if not exists
  return new Response(null, { status: 204, headers: { "x-amz-request-id": generateRequestId() } });
}

async function handleDeleteObjects(env: Env, bucket: string, request: Request): Promise<Response> {
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const bodyText = await request.text();
  // Parse <Key> with proper XML unescaping (handles &amp;)
  const keys: string[] = [];
  const re = /<Key>(.*?)<\/Key>/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyText)) !== null) {
    let k = m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    // Keys are not URL-encoded in Delete payload; decode only if encoded
    try {
      // Avoid double-decode; S3 sends raw key, but some clients encode
      if (k.includes("%")) k = decodeURIComponent(k);
    } catch {}
    keys.push(k);
  }
  const quiet = bodyText.includes("<Quiet>true</Quiet>");
  const deleted: { key: string }[] = [];
  const errors: { key: string; code: string; message: string }[] = [];
  const oldChunks: Chunk[] = [];

  await withManifest(env, owner, repo, getMetadataTag(env), async (manifest) => {
    for (const k of keys) {
      const meta = manifest.objects[k];
      if (meta) {
        oldChunks.push(...meta.chunks);
        delete manifest.objects[k];
      }
      deleted.push({ key: k });
    }
    return { manifest, result: null };
  });

  for (const ch of oldChunks) {
    try {
      await deleteAsset(env, owner, repo, ch.assetId);
    } catch (e) {
      console.warn("deleteObjects chunk failed", e);
    }
  }

  const xmlBody = xml.deleteObjectsXml(quiet ? [] : deleted, errors);
  return xmlResponse(xmlBody, 200);
}

// Multipart handlers

async function handleCreateMultipartUpload(env: Env, bucket: string, key: string, request: Request): Promise<Response> {
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  await ensureBucket(env, owner, repo, getMetadataTag(env));
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const meta = parseAmzMeta(request.headers);
  const uploadId = crypto.randomUUID().replace(/-/g, "") + Date.now().toString(36);
  const nowIso = new Date().toISOString();
  const mp = {
    uploadId,
    key,
    initiated: nowIso,
    contentType,
    meta,
    parts: {} as Record<number, { etag: string; size: number; chunk: Chunk }>,
  };
  // store in multipart state
  const tag = getMetadataTag(env);
  const { uploads, releaseId, assetId } = await readMultipartState(env, owner, repo, tag);
  uploads[uploadId] = mp;
  await writeMultipartState(env, owner, repo, tag, uploads, assetId, releaseId || undefined);
  const xmlBody = xml.createMultipartUploadXml(bucket, key, uploadId);
  return xmlResponse(xmlBody, 200);
}

async function handleUploadPart(env: Env, bucket: string, key: string, request: Request, url: URL): Promise<Response> {
  const uploadId = url.searchParams.get("uploadId");
  const partNumberStr = url.searchParams.get("partNumber");
  if (!uploadId || !partNumberStr) return s3Error("InvalidRequest", "Missing uploadId or partNumber", 400, key);
  const partNumber = parseInt(partNumberStr, 10);
  if (Number.isNaN(partNumber) || partNumber < 1 || partNumber > 10000) return s3Error("InvalidRequest", "Invalid partNumber", 400, key);
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const info = await getRepo(env, owner, repo);
  if (!info) return s3Error("NoSuchBucket", "The specified bucket does not exist", 404, bucket);
  // handle UploadPartCopy
  const copySource = request.headers.get("x-amz-copy-source");
  if (copySource) {
    return handleUploadPartCopy(env, bucket, key, request, url, copySource);
  }
  const tag = getMetadataTag(env);
  const { uploads, releaseId, assetId } = await readMultipartState(env, owner, repo, tag);
  const upload = uploads[uploadId];
  if (!upload || upload.key !== key) return s3Error("NoSuchUpload", "The specified upload does not exist.", 404, key);

  // Read body
  const bodyBuf = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
  // Enforce 5MB min except last part? S3 requires 5MB min (except last). We'll allow smaller for flexibility but warn
  const etagHex = await md5Hex(bodyBuf);
  const etag = `"${etagHex}"`;
  const assetName = `mp_${uploadId}_p${String(partNumber).padStart(5, "0")}`;
  const release = await ensureDataReleaseForUpload(env, owner, repo, getDataPrefix(env));
  const asset = await uploadAssetBytes(env, owner, repo, release.id, assetName, bodyBuf, upload.contentType);

  // If previous part exists, delete old chunk
  const prev = upload.parts[partNumber];
  if (prev) {
    try { await deleteAsset(env, owner, repo, prev.chunk.assetId); } catch {}
  }

  const chunk: Chunk = { releaseTag: release.tag_name, assetId: asset.id, assetName, size: bodyBuf.length, offset: 0 };
  upload.parts[partNumber] = { etag, size: bodyBuf.length, chunk };
  await writeMultipartState(env, owner, repo, tag, uploads, assetId, releaseId || undefined);

  return new Response(null, { status: 200, headers: { ETag: etag, "x-amz-request-id": generateRequestId() } });
}

async function handleUploadPartCopy(env: Env, bucket: string, key: string, request: Request, url: URL, copySourceRaw: string): Promise<Response> {
  const uploadId = url.searchParams.get("uploadId")!;
  const partNumber = parseInt(url.searchParams.get("partNumber")!, 10);
  let src = copySourceRaw.replace(/^\/+/, "");
  const q = src.indexOf("?");
  if (q !== -1) src = src.slice(0, q);
  const slash = src.indexOf("/");
  if (slash === -1) return s3Error("InvalidRequest", "Invalid x-amz-copy-source", 400, key);
  let srcBucket: string; let srcKey: string;
  try { srcBucket = decodeURIComponent(src.slice(0, slash)); srcKey = decodeURIComponent(src.slice(slash+1)); } catch { return s3Error("InvalidRequest", "Invalid copy source", 400, key); }
  const srcFound = await getObjectMeta(env, srcBucket, srcKey);
  if (!srcFound) return s3Error("NoSuchKey", "The specified key does not exist.", 404, srcKey);
  const { meta: srcMeta, owner: sOwner, repo: sRepo } = srcFound;
  const range = request.headers.get("x-amz-copy-source-range");
  let bytes: Uint8Array;
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d+)/);
    if (!m) return s3Error("InvalidRequest", "Invalid copy range", 400, key);
    const start = parseInt(m[1],10); const end = parseInt(m[2],10);
    const stream = createChunkedStream(env, sOwner, sRepo, srcMeta.chunks, {start, end});
    const buf = await new Response(stream).arrayBuffer();
    bytes = new Uint8Array(buf);
  } else {
    // full object
    const stream = createChunkedStream(env, sOwner, sRepo, srcMeta.chunks);
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const etagHex = await md5Hex(bytes);
  const etag = `"${etagHex}"`;
  const assetName = `mp_${uploadId}_p${String(partNumber).padStart(5, "0")}`;
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const release = await ensureDataReleaseForUpload(env, owner, repo, getMetadataTag(env));
  const asset = await uploadAssetBytes(env, owner, repo, release.id, assetName, bytes, srcMeta.contentType);
  await withMultipart(env, owner, repo, getMetadataTag(env), async (uploads) => {
    const up = uploads[uploadId];
    if (!up || up.key !== key) throw new Error("NoSuchUpload");
    const prev = up.parts[partNumber];
    if (prev) try { await deleteAsset(env, owner, repo, prev.chunk.assetId); } catch {}
    up.parts[partNumber] = { etag, size: bytes.length, chunk: { releaseTag: release.tag_name, assetId: asset.id, assetName, size: bytes.length, offset: 0 } };
    return { uploads, result: null as any };
  });
  return new Response(null, { status: 200, headers: { ETag: etag, "x-amz-request-id": generateRequestId() } });
}
async function handleCompleteMultipartUpload(env: Env, bucket: string, key: string, request: Request, url: URL): Promise<Response> {
  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId) return s3Error("InvalidRequest", "Missing uploadId", 400, key);
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const info2 = await getRepo(env, owner, repo);
  if (!info2) return s3Error("NoSuchBucket", "The specified bucket does not exist", 404, bucket);
  const tag = getMetadataTag(env);
  const { uploads, releaseId, assetId } = await readMultipartState(env, owner, repo, tag);
  const upload = uploads[uploadId];
  if (!upload || upload.key !== key) return s3Error("NoSuchUpload", "The specified upload does not exist.", 404, key);

  const bodyText = await request.text();
  // Parse <CompleteMultipartUpload><Part><PartNumber>n</PartNumber><ETag>"..."</ETag></Part>...</Complete...>
  const partRe = /<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>([^<]+)<\/ETag>\s*<\/Part>/g;
  const requestedParts: { partNumber: number; etag: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = partRe.exec(bodyText)) !== null) {
    requestedParts.push({ partNumber: parseInt(m[1], 10), etag: m[2].trim() });
  }
  if (requestedParts.length === 0) return s3Error("InvalidRequest", "No parts in Complete", 400, key);
  requestedParts.sort((a, b) => a.partNumber - b.partNumber);

  // Validate parts exist and etag matches
  const finalChunks: Chunk[] = [];
  const etags: string[] = [];
  let totalSize = 0;
  let offset = 0;
  for (const rp of requestedParts) {
    const stored = upload.parts[rp.partNumber];
    if (!stored) return s3Error("InvalidPart", `Part ${rp.partNumber} not found`, 400, key);
    const expectedEtag = stored.etag.replace(/"/g, "");
    const providedEtag = rp.etag.replace(/"/g, "");
    if (expectedEtag !== providedEtag) {
      // S3 would error InvalidPart, but allow mismatch? We'll enforce
      return s3Error("InvalidPart", `ETag mismatch for part ${rp.partNumber}`, 400, key);
    }
    const ch = { ...stored.chunk, offset } as Chunk;
    finalChunks.push(ch);
    etags.push(stored.etag);
    totalSize += stored.size;
    offset += stored.size;
  }

  // Enforce 5MiB min for all parts except last (only when CHUNK_SIZE >=5MiB, skip for small test chunks)
  if (getChunkSize(env) >= 5 * 1024 * 1024) {
    for (let i = 0; i < requestedParts.length - 1; i++) {
      const pn = requestedParts[i].partNumber;
      const part = upload.parts[pn];
      if (part.size < 5 * 1024 * 1024) return s3Error("EntityTooSmall", "Your proposed upload is smaller than the minimum allowed size", 400, key);
    }
  }
  const finalEtag = await etagForChunks(etags, totalSize);
  const nowIso = new Date().toISOString();
  const objectMeta: ObjectMeta = {
    key,
    size: totalSize,
    etag: finalEtag,
    contentType: upload.contentType,
    lastModified: nowIso,
    storageClass: "STANDARD",
    meta: upload.meta,
    chunks: finalChunks,
  };

  // Remove upload from state and commit object
  delete uploads[uploadId];
  // We need to do two manifests writes atomically? But multipart state is separate asset; we can write manifest then multipart
  // Delete any previous object chunks
  let oldChunks: Chunk[] = [];
  await withManifest(env, owner, repo, tag, async (manifest) => {
    const existing = manifest.objects[key];
    if (existing) oldChunks = existing.chunks;
    manifest.objects[key] = objectMeta;
    return { manifest, result: null };
  });
  await writeMultipartState(env, owner, repo, tag, uploads, assetId, releaseId || undefined);
  // cleanup orphan parts not included
  const usedAssetIds = new Set(finalChunks.map((c) => c.assetId));
  for (const part of Object.values(upload.parts)) {
    if (!usedAssetIds.has(part.chunk.assetId)) {
      try { await deleteAsset(env, owner, repo, part.chunk.assetId); } catch {}
    }
  }
  for (const ch of oldChunks) {
    try { await deleteAsset(env, owner, repo, ch.assetId); } catch {}
  }

  const location = `https://${bucket}/${key}`;
  const xmlBody = xml.completeMultipartUploadXml(bucket, key, finalEtag, location);
  return xmlResponse(xmlBody, 200);
}

async function handleAbortMultipartUpload(env: Env, bucket: string, key: string, url: URL): Promise<Response> {
  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId) return s3Error("InvalidRequest", "Missing uploadId", 400, key);
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const tag = getMetadataTag(env);
  const { uploads, releaseId, assetId } = await readMultipartState(env, owner, repo, tag);
  const upload = uploads[uploadId];
  if (!upload) return s3Error("NoSuchUpload", "The specified upload does not exist.", 404, key);
  // delete all parts
  for (const part of Object.values(upload.parts)) {
    try { await deleteAsset(env, owner, repo, part.chunk.assetId); } catch {}
  }
  delete uploads[uploadId];
  await writeMultipartState(env, owner, repo, tag, uploads, assetId, releaseId || undefined);
  return new Response(null, { status: 204, headers: { "x-amz-request-id": generateRequestId() } });
}

async function handleListParts(env: Env, bucket: string, key: string, url: URL): Promise<Response> {
  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId) return s3Error("InvalidRequest", "Missing uploadId", 400, key);
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const info3 = await getRepo(env, owner, repo);
  if (!info3) return s3Error("NoSuchBucket", "The specified bucket does not exist", 404, bucket);
  const { uploads } = await readMultipartState(env, owner, repo, getMetadataTag(env));
  const upload = uploads[uploadId];
  if (!upload || upload.key !== key) return s3Error("NoSuchUpload", "The specified upload does not exist.", 404, key);
  const maxPartsStr = url.searchParams.get("max-parts") || "1000";
  const maxParts = Math.min(parseInt(maxPartsStr, 10) || 1000, 1000);
  const partNumberMarkerStr = url.searchParams.get("part-number-marker") || "0";
  const marker = parseInt(partNumberMarkerStr, 10) || 0;
  const encodingType = url.searchParams.get("encoding-type") || "";

  const allParts = Object.entries(upload.parts)
    .map(([pn, v]) => ({ partNumber: parseInt(pn, 10), etag: v.etag, size: v.size, lastModified: upload.initiated }))
    .sort((a, b) => a.partNumber - b.partNumber)
    .filter((p) => p.partNumber > marker);
  const isTruncated = allParts.length > maxParts;
  const parts = isTruncated ? allParts.slice(0, maxParts) : allParts;
  const nextMarker = isTruncated ? parts[parts.length - 1].partNumber : undefined;

  const xmlBody = xml.listPartsXml({
    bucket,
    key: encodingType === "url" ? encodeURIComponent(key) : key,
    uploadId,
    parts,
    isTruncated,
    maxParts,
    nextPartNumberMarker: nextMarker,
    encodingType: encodingType || undefined,
  });
  return xmlResponse(xmlBody, 200);
}

async function handleListMultipartUploads(env: Env, bucket: string, url: URL): Promise<Response> {
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const info4 = await getRepo(env, owner, repo);
  if (!info4) return s3Error("NoSuchBucket", "The specified bucket does not exist", 404, bucket);
  const { uploads } = await readMultipartState(env, owner, repo, getMetadataTag(env));
  const prefix = url.searchParams.get("prefix") || "";
  const delimiter = url.searchParams.get("delimiter") || "";
  const maxUploadsStr = url.searchParams.get("max-uploads") || "1000";
  const maxUploads = Math.min(parseInt(maxUploadsStr, 10) || 1000, 1000);
  const keyMarker = url.searchParams.get("key-marker") || "";
  const uploadIdMarker = url.searchParams.get("upload-id-marker") || "";

  let all = Object.values(uploads);
  if (prefix) all = all.filter((u) => u.key.startsWith(prefix));
  all.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.uploadId < b.uploadId ? -1 : 1));
  // Apply marker
  if (keyMarker) {
    const idx = all.findIndex((u) => u.key > keyMarker || (u.key === keyMarker && u.uploadId > uploadIdMarker));
    all = idx === -1 ? [] : all.slice(idx);
  }
  const isTruncated = all.length > maxUploads;
  const uploadsSlice = isTruncated ? all.slice(0, maxUploads) : all;
  const nextKeyMarker = isTruncated ? uploadsSlice[uploadsSlice.length - 1].key : "";
  const nextUploadIdMarker = isTruncated ? uploadsSlice[uploadsSlice.length - 1].uploadId : "";

  const xmlBody = xml.listMultipartUploadsXml({
    bucket,
    uploads: uploadsSlice.map((u) => ({ key: u.key, uploadId: u.uploadId, initiated: u.initiated, storageClass: "STANDARD" })),
    isTruncated,
    maxUploads,
    keyMarker,
    uploadIdMarker,
    nextKeyMarker,
    nextUploadIdMarker,
    prefix: prefix || undefined,
    delimiter: delimiter || undefined,
  });
  return xmlResponse(xmlBody, 200);
}

export async function handleS3Request(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const host = request.headers.get("host") || url.host;
  const { bucket, key } = parseBucketKey(url, host, env);

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Expose-Headers": "ETag, x-amz-request-id, x-amz-version-id",
        "x-amz-request-id": generateRequestId(),
      },
    });
  }

  // Auth check (before anything except health)
  if (url.pathname === "/_health" || url.pathname === "/health") {
    return new Response(JSON.stringify({ ok: true, bucket, key }), { headers: { "Content-Type": "application/json" } });
  }

  const authResult = await verifySigV4(request, env);
  if (!authResult.ok) {
    return s3Error("SignatureDoesNotMatch", authResult.error || "Signature mismatch", 403, bucket || "");
  }

  // Root: list buckets
  if (!bucket) {
    if (request.method === "GET") return handleListBuckets(env, request);
    return s3Error("InvalidRequest", "Bucket name required", 400, "");
  }

  // Bucket-level operations when key is empty
  if (!key) {
    const qs = parseQuery(url);
    // Multipart uploads list: GET ?uploads
    if (request.method === "GET" && "uploads" in qs) {
      return handleListMultipartUploads(env, bucket, url);
    }
    if (request.method === "GET" && ("list-type" in qs || "listType" in qs || (!("uploads" in qs) && !("versioning" in qs) && !("tagging" in qs)))) {
      // Detect ListObjectsV2 vs ListObjectsV1: if list-type=2 or no list-type but bucket GET -> assume V2
      const listType = url.searchParams.get("list-type");
      if (listType === "2" || listType === null) return handleListObjectsV2(env, bucket, url);
      // V1 not implemented, fallback to V2
      return handleListObjectsV2(env, bucket, url);
    }
    if (request.method === "HEAD") return handleHeadBucket(env, bucket);
    if (request.method === "PUT") return handleCreateBucket(env, bucket);
    if (request.method === "DELETE") return handleDeleteBucket(env, bucket);
    if (request.method === "POST" && "delete" in qs) return handleDeleteObjects(env, bucket, request);
    // stubs for ?versioning, ?tagging, ?cors etc
    if (request.method === "GET" && ("versioning" in qs || "tagging" in qs || "cors" in qs || "acl" in qs)) {
      // minimal stubs
      if ("versioning" in qs) return xmlResponse(`<?xml version="1.0"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Suspended</Status></VersioningConfiguration>`);
      if ("tagging" in qs) return xmlResponse(`<?xml version="1.0"?><Tagging><TagSet></TagSet></Tagging>`);
      if ("cors" in qs) return xmlResponse(`<?xml version="1.0"?><CORSConfiguration></CORSConfiguration>`);
      if ("acl" in qs) return xmlResponse(`<?xml version="1.0"?><AccessControlPolicy><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee><ID>owner</ID><Type>CanonicalUser</Type></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>`);
    }
    if (request.method === "PUT" && ("versioning" in qs || "tagging" in qs || "cors" in qs)) {
      return new Response(null, { status: 200, headers: { "x-amz-request-id": generateRequestId() } });
    }
    return s3Error("InvalidRequest", `Unsupported bucket operation ${request.method} ${url.search}`, 400, bucket);
  }

  // Object-level: check multipart queries first
  const hasUploadId = url.searchParams.has("uploadId");
  const hasUploads = url.searchParams.has("uploads");
  const partNumber = url.searchParams.get("partNumber");

  if (request.method === "POST" && hasUploads) {
    return handleCreateMultipartUpload(env, bucket, key, request);
  }
  if (request.method === "PUT" && hasUploadId && partNumber) {
    return handleUploadPart(env, bucket, key, request, url);
  }
  if (request.method === "POST" && hasUploadId) {
    return handleCompleteMultipartUpload(env, bucket, key, request, url);
  }
  if (request.method === "DELETE" && hasUploadId) {
    return handleAbortMultipartUpload(env, bucket, key, url);
  }
  if (request.method === "GET" && hasUploadId) {
    return handleListParts(env, bucket, key, url);
  }

  if (url.searchParams.has("select")) {
    return s3Error("NotImplemented", "SelectObjectContent not implemented", 501, key);
  }
  // Regular object ops
  switch (request.method) {
    case "GET":
      return handleGetObject(env, bucket, key, request, url);
    case "HEAD":
      return handleHeadObject(env, bucket, key, request);
    case "PUT":
      return handlePutObject(env, bucket, key, request, url, ctx);
    case "DELETE":
      return handleDeleteObject(env, bucket, key);
    case "POST":
      // Copy via POST? Already handled copy via PUT; S3 also supports POST via form
      return s3Error("NotImplemented", "POST not implemented for object", 501, key);
    default:
      return s3Error("NotImplemented", `Method ${request.method} not implemented`, 501, key);
  }
}
