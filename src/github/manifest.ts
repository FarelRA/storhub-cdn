import type { Env, Manifest, MultipartUpload } from "../types";
import { deleteAsset, downloadAsset, ensureRelease, getReleaseByTag, listAllReleaseAssets, uploadAssetBytes } from "./client";

const INDEX_NAME = "index.json";
const MULTIPART_NAME = "multipart.json";

/**
 * Manifest is stored as a single asset in the metadata release.
 * We also support sharded manifest later, but MVP is single JSON.
 */

export async function readManifest(
  env: Env,
  owner: string,
  repo: string,
  metadataTag: string,
): Promise<{ manifest: Manifest; releaseId: number; assetId?: number }> {
  const kvKey = `manifest:${owner}/${repo}:${metadataTag}`;
  if (env.KV_CACHE) {
    const cached = await env.KV_CACHE.get(kvKey, "json");
    if (cached) {
      const c = cached as { manifest: Manifest; updatedAt: string; releaseId: number; assetId: number };
      if (c.manifest && c.updatedAt && c.releaseId) {
        // Trust TTL (300s) - return without GitHub fetch
        return { manifest: c.manifest, releaseId: c.releaseId, assetId: c.assetId };
      }
    }
  }
  const rel = await getReleaseByTag(env, owner, repo, metadataTag);
  if (!rel) {
    const newRel = await ensureRelease(env, owner, repo, metadataTag);
    const empty: Manifest = { version: 1, bucket: `${owner}/${repo}`, objects: {} };
    return { manifest: empty, releaseId: newRel.id };
  }
  const assets = await listAllReleaseAssets(env, owner, repo, rel.id);
  const idxAsset = assets.find((a) => a.name === INDEX_NAME);
  if (!idxAsset) {
    const empty: Manifest = { version: 1, bucket: `${owner}/${repo}`, objects: {} };
    return { manifest: empty, releaseId: rel.id };
  }
  const res = await downloadAsset(env, owner, repo, idxAsset.id);
  const buf = await res.arrayBuffer();
  const txt = new TextDecoder().decode(buf);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(txt) as Manifest;
  } catch {
    manifest = { version: 1, bucket: `${owner}/${repo}`, objects: {} };
  }
  if (!manifest.objects) manifest.objects = {};
  if ((manifest as any).nextDataIndex) delete (manifest as any).nextDataIndex;
  if (manifest.version !== 1) manifest.version = 1;

  if (env.KV_CACHE) {
    await env.KV_CACHE.put(kvKey, JSON.stringify({ manifest, updatedAt: idxAsset.updated_at, releaseId: rel.id, assetId: idxAsset.id }), {
      expirationTtl: 300,
    });
  }
  return { manifest, releaseId: rel.id, assetId: idxAsset.id };
}

export async function writeManifest(
  env: Env,
  owner: string,
  repo: string,
  metadataTag: string,
  manifest: Manifest,
  previousAssetId?: number,
  releaseId?: number,
): Promise<number> {
  let relId = releaseId;
  if (!relId) {
    const rel = await ensureRelease(env, owner, repo, metadataTag);
    relId = rel.id;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  // Upload first, then delete old — atomic delete-then-upload window would lose data if upload fails
  const asset = await uploadAssetBytes(env, owner, repo, relId, INDEX_NAME, bytes, "application/json");
  if (previousAssetId && previousAssetId !== asset.id) {
    try {
      await deleteAsset(env, owner, repo, previousAssetId);
    } catch (e) {
      console.warn(`delete old manifest asset ${previousAssetId} failed`, e);
    }
  }
  if (env.KV_CACHE) {
    const kvKey = `manifest:${owner}/${repo}:${metadataTag}`;
    await env.KV_CACHE.put(kvKey, JSON.stringify({ manifest, updatedAt: asset.updated_at, releaseId: relId, assetId: asset.id }), {
      expirationTtl: 300,
    });
  }
  return asset.id;
}

async function readManifestFresh(
  env: Env,
  owner: string,
  repo: string,
  metadataTag: string,
): Promise<{ manifest: Manifest; releaseId: number; assetId?: number; updatedAt?: string }> {
  const rel = await getReleaseByTag(env, owner, repo, metadataTag);
  if (!rel) {
    const newRel = await ensureRelease(env, owner, repo, metadataTag);
    const empty: Manifest = { version: 1, bucket: `${owner}/${repo}`, objects: {} };
    return { manifest: empty, releaseId: newRel.id };
  }
  const assets = await listAllReleaseAssets(env, owner, repo, rel.id);
  const idxAsset = assets.find((a) => a.name === INDEX_NAME);
  if (!idxAsset) {
    const empty: Manifest = { version: 1, bucket: `${owner}/${repo}`, objects: {} };
    return { manifest: empty, releaseId: rel.id };
  }
  const res = await downloadAsset(env, owner, repo, idxAsset.id);
  const buf = await res.arrayBuffer();
  const txt = new TextDecoder().decode(buf);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(txt) as Manifest;
  } catch {
    manifest = { version: 1, bucket: `${owner}/${repo}`, objects: {} };
  }
  if (!manifest.objects) manifest.objects = {};
  if ((manifest as any).nextDataIndex) delete (manifest as any).nextDataIndex;
  if (manifest.version !== 1) manifest.version = 1;
  return { manifest, releaseId: rel.id, assetId: idxAsset.id, updatedAt: idxAsset.updated_at };
}

/**
 * Atomic manifest update with retry loop (optimistic concurrency)
 * Uses fresh reads bypassing KV to avoid stale race detection
 */
export async function withManifest<T>(
  env: Env,
  owner: string,
  repo: string,
  metadataTag: string,
  mutator: (manifest: Manifest) => Promise<{ manifest: Manifest; result: T } | null>,
  maxRetries = 5,
): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { manifest, releaseId, assetId } = await readManifestFresh(env, owner, repo, metadataTag);
    const clone: Manifest = JSON.parse(JSON.stringify(manifest));
    const mutated = await mutator(clone);
    if (!mutated) throw new Error("mutator returned null");
    const newManifest = mutated.manifest;
    try {
      // Check race: if asset changed since we read, retry
      const fresh = await getReleaseByTag(env, owner, repo, metadataTag);
      if (fresh && assetId) {
        const freshAssets = await listAllReleaseAssets(env, owner, repo, fresh.id);
        const freshIdx = freshAssets.find((a) => a.name === INDEX_NAME);
        const freshId = freshIdx?.id;
        if (freshId && freshId !== assetId) {
          console.warn(`manifest race detected attempt ${attempt} expected ${assetId} got ${freshId}, retrying`);
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1) + Math.random() * 100));
          continue;
        }
      }
      await writeManifest(env, owner, repo, metadataTag, newManifest, assetId, releaseId);
      return mutated.result;
    } catch (e: any) {
      lastErr = e;
      // Retry on 409/422/500
      const msg = String(e?.message || "");
      const isRetryable = msg.includes("409") || msg.includes("422") || msg.includes("500") || msg.includes("race");
      if (!isRetryable && attempt >= 2) throw e;
      console.warn(`withManifest attempt ${attempt} failed`, e?.message);
      if (attempt === maxRetries - 1) throw e;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1) + Math.random() * 100));
      continue;
    }
  }
  throw lastErr;
}

export async function readMultipartState(
  env: Env,
  owner: string,
  repo: string,
  metadataTag: string,
): Promise<{ uploads: Record<string, MultipartUpload>; releaseId: number; assetId?: number }> {
  const rel = await ensureRelease(env, owner, repo, metadataTag);
  const assets = await listAllReleaseAssets(env, owner, repo, rel.id);
  const mpAsset = assets.find((a) => a.name === MULTIPART_NAME);
  if (!mpAsset) return { uploads: {}, releaseId: rel.id };
  const res = await downloadAsset(env, owner, repo, mpAsset.id);
  const txt = await res.text();
  try {
    const data = JSON.parse(txt);
    return { uploads: data.uploads || {}, releaseId: rel.id, assetId: mpAsset.id };
  } catch {
    return { uploads: {}, releaseId: rel.id, assetId: mpAsset.id };
  }
}

export async function withMultipart<T>(
  env: Env,
  owner: string,
  repo: string,
  metadataTag: string,
  mutator: (uploads: Record<string, MultipartUpload>) => Promise<{ uploads: Record<string, MultipartUpload>; result: T } | null>,
  maxRetries = 5,
): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { uploads, releaseId, assetId } = await readMultipartState(env, owner, repo, metadataTag);
    const clone = JSON.parse(JSON.stringify(uploads));
    const mutated = await mutator(clone);
    if (!mutated) throw new Error("mutator null");
    try {
      const fresh = await readMultipartState(env, owner, repo, metadataTag);
      if (assetId && fresh.assetId && fresh.assetId !== assetId) {
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        continue;
      }
      await writeMultipartState(env, owner, repo, metadataTag, mutated.uploads, assetId, releaseId);
      return mutated.result;
    } catch (e: any) {
      lastErr = e;
      if (attempt === maxRetries - 1) throw e;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function writeMultipartState(
  env: Env,
  owner: string,
  repo: string,
  metadataTag: string,
  uploads: Record<string, MultipartUpload>,
  previousAssetId?: number,
  releaseId?: number,
): Promise<number> {
  let relId = releaseId;
  if (!relId) {
    const rel = await ensureRelease(env, owner, repo, metadataTag);
    relId = rel.id;
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ uploads }));
  const asset = await uploadAssetBytes(env, owner, repo, relId, MULTIPART_NAME, bytes, "application/json");
  if (previousAssetId && previousAssetId !== asset.id) {
    try {
      await deleteAsset(env, owner, repo, previousAssetId);
    } catch {}
  }
  return asset.id;
}
