import type { Env, ObjectMeta } from "../../types";
import { s3Error, xmlResponse, generateRequestId } from "../util";
import * as xml from "../xml";
import { readManifest } from "../../github/manifest";
import { getRepo, createRepo, getAuthenticatedUser } from "../../github/client";
import { getMetadataTag, resolveBucketRepo } from "./helpers";

export async function handleListBuckets(env: Env, request: Request): Promise<Response> {
  let buckets: { name: string; creationDate: string }[] = [];
  if (env.BUCKET_REPOS) {
    try {
      const m = JSON.parse(env.BUCKET_REPOS) as Record<string, string>;
      for (const b of Object.keys(m)) {
        const { owner, repo } = await resolveBucketRepo(env, b);
        const info = await getRepo(env, owner, repo).catch(() => null);
        if (!info) continue;
        try {
          const { getReleaseByTag: getR } = await import("../../github/client");
          const rel = await getR(env, owner, repo, getMetadataTag(env));
          if (!rel) continue;
        } catch {}
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
      const filtered: typeof list = [];
      for (const r of list.slice(0, 20)) {
        try {
          const { getReleaseByTag: getR2 } = await import("../../github/client");
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

export async function handleHeadBucket(env: Env, bucket: string): Promise<Response> {
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const info = await getRepo(env, owner, repo);
  if (!info) return s3Error("NoSuchBucket", "The specified bucket does not exist", 404, bucket);
  return new Response(null, { status: 200, headers: { "x-amz-bucket-region": "us-east-1", "x-amz-request-id": generateRequestId() } });
}

export async function handleCreateBucket(env: Env, bucket: string): Promise<Response> {
  // S3 bucket naming validation
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..") || bucket.startsWith("xn--")) {
    return s3Error("InvalidBucketName", "The specified bucket is not valid.", 400, bucket);
  }
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const existing = await getRepo(env, owner, repo);
  if (existing) return s3Error("BucketAlreadyOwnedByYou", "Your previous request to create the named bucket succeeded and you already own it.", 409, bucket);
  await ensureBucket(env, owner, repo);
  return new Response(null, { status: 200, headers: { Location: `/${bucket}`, "x-amz-request-id": generateRequestId() } });
}

export async function handleDeleteBucket(env: Env, bucket: string): Promise<Response> {
  const { owner, repo } = await resolveBucketRepo(env, bucket);
  const info = await getRepo(env, owner, repo);
  if (!info) return s3Error("NoSuchBucket", "The specified bucket does not exist", 404, bucket);
  const { readMultipartState } = await import("../../github/manifest");
  const { manifest } = await readManifest(env, owner, repo, getMetadataTag(env));
  if (Object.keys(manifest.objects).length > 0) return s3Error("BucketNotEmpty", "The bucket you tried to delete is not empty", 409, bucket);
  const { uploads } = await readMultipartState(env, owner, repo, getMetadataTag(env));
  if (Object.keys(uploads).length > 0) return s3Error("BucketNotEmpty", "The bucket you tried to delete is not empty (multipart uploads in progress)", 409, bucket);
  return new Response(null, { status: 204, headers: { "x-amz-request-id": generateRequestId() } });
}

export async function handleListObjectsV2(env: Env, bucket: string, url: URL): Promise<Response> {
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
  const fetchOwner = url.searchParams.get("fetch-owner") === "true";

  const base64Decode = (s: string): string => {
    try { return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); } catch { try { return atob(s); } catch { return s; } }
  };
  const base64Encode = (s: string): string => {
    try { const bytes = new TextEncoder().encode(s); let binary = ""; for (const b of bytes) binary += String.fromCharCode(b); return btoa(binary); } catch { return btoa(s); }
  };
  let startKey = "";
  if (continuationToken) startKey = base64Decode(continuationToken);
  else if (startAfter) startKey = startAfter;

  let allKeys = Object.keys(manifest.objects).sort();
  if (prefix) allKeys = allKeys.filter((k) => k.startsWith(prefix));
  if (startKey) {
    const idx = allKeys.findIndex((k) => k > startKey);
    allKeys = idx === -1 ? [] : allKeys.slice(idx);
  }

  const contents: { key: string; lastModified: string; etag: string; size: number; storageClass: string; owner?: string }[] = [];
  const commonPrefixesSet = new Set<string>();
  let truncated = false;
  let nextToken: string | undefined;
  let resultCount = 0;
  let lastKey = "";
  for (const k of allKeys) {
    if (resultCount >= maxKeys) { truncated = true; nextToken = base64Encode(lastKey); break; }
    const meta = manifest.objects[k]!;
    if (delimiter) {
      const suffix = k.slice(prefix.length);
      const delimIdx = suffix.indexOf(delimiter);
      if (delimIdx !== -1) {
        const cp = prefix + suffix.slice(0, delimIdx + delimiter.length);
        if (!commonPrefixesSet.has(cp)) {
          if (resultCount >= maxKeys) { truncated = true; nextToken = base64Encode(lastKey); break; }
          commonPrefixesSet.add(cp);
          resultCount++;
          lastKey = k;
        }
        continue;
      }
    }
    contents.push({
      key: encodingType === "url" ? encodeURIComponent(k) : k,
      lastModified: meta.lastModified,
      etag: meta.etag,
      size: meta.size,
      storageClass: meta.storageClass || "STANDARD",
      owner: fetchOwner ? "storhub" : undefined,
    });
    resultCount++;
    lastKey = k;
  }

  const commonPrefixesEncoded = encodingType === "url" ? Array.from(commonPrefixesSet).sort().map((p) => encodeURIComponent(p)) : Array.from(commonPrefixesSet).sort();

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
    contents: contents as any,
  });
  return xmlResponse(xmlBody, 200);
}

async function ensureBucket(env: Env, owner: string, repo: string) {
  const { getRepo, createRepo, getAuthenticatedUser } = await import("../../github/client");
  const { ensureRelease } = await import("../../github/client");
  const repoInfo = await getRepo(env, owner, repo);
  if (!repoInfo) {
    const user = await getAuthenticatedUser(env);
    const isOrg = owner.toLowerCase() !== user.login.toLowerCase();
    await createRepo(env, owner, repo, isOrg);
  }
  await ensureRelease(env, owner, repo, getMetadataTag(env));
}
