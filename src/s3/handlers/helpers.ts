import type { Env } from "../../types";

export function getMetadataTag(env: Env): string {
  return env.METADATA_TAG || "s3-metadata";
}
export function getDataPrefix(env: Env): string {
  return env.DATA_TAG_PREFIX || "s3-data-";
}
export async function resolveBucketRepo(env: Env, bucket: string): Promise<{ owner: string; repo: string }> {
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
  if (env.GITHUB_OWNER) return { owner: env.GITHUB_OWNER, repo: bucket };
  if (bucket.includes("/")) {
    const [o, r] = bucket.split("/", 2);
    return { owner: o, repo: r };
  }
  throw new Error(`Cannot resolve bucket repo for ${bucket}: set BUCKET_REPOS or GITHUB_OWNER`);
}
export function chunkAssetName(key: string, partIndex: number, uploadId: string): string {
  return `chk_${uploadId}_p${String(partIndex).padStart(6, "0")}`;
}
