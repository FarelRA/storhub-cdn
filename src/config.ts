import type { Env } from "./types";

export type ParsedEnv = {
  githubPat: string;
  githubOwner?: string;
  bucketRepos: Record<string, string>;
  metadataTag: string;
  dataTagPrefix: string;
  chunkSize: number;
  s3PublicRead: boolean;
  s3Keys: Record<string, string>;
};

export function parseEnv(env: Env): ParsedEnv {
  const chunkSizeRaw = env.CHUNK_SIZE ? parseInt(env.CHUNK_SIZE, 10) : 48 * 1024 * 1024;
  const chunkSize = Number.isNaN(chunkSizeRaw) || chunkSizeRaw <= 0 ? 48 * 1024 * 1024 : Math.min(Math.max(chunkSizeRaw, 5 * 1024), 90 * 1024 * 1024);
  let bucketRepos: Record<string, string> = {};
  if (env.BUCKET_REPOS) {
    try {
      const m = JSON.parse(env.BUCKET_REPOS);
      if (m && typeof m === "object") bucketRepos = m as Record<string, string>;
    } catch {}
  }
  let s3Keys: Record<string, string> = {};
  if (env.S3_KEYS_JSON) {
    try {
      const j = JSON.parse(env.S3_KEYS_JSON);
      if (j && typeof j === "object") s3Keys = j as Record<string, string>;
    } catch {}
  }
  if (env.S3_ACCESS_KEY && env.S3_SECRET_KEY) s3Keys[env.S3_ACCESS_KEY] = env.S3_SECRET_KEY;

  return {
    githubPat: env.GITHUB_PAT,
    githubOwner: env.GITHUB_OWNER,
    bucketRepos,
    metadataTag: env.METADATA_TAG || "s3-metadata",
    dataTagPrefix: env.DATA_TAG_PREFIX || "s3-data-",
    chunkSize,
    s3PublicRead: env.S3_PUBLIC_READ === "true",
    s3Keys,
  };
}

export function getBucketRepo(parsed: ParsedEnv, bucket: string): { owner: string; repo: string } {
  if (parsed.bucketRepos[bucket]) {
    const v = parsed.bucketRepos[bucket];
    const parts = v.split("/");
    if (parts.length === 2) return { owner: parts[0], repo: parts[1] };
  }
  if (parsed.githubOwner) return { owner: parsed.githubOwner, repo: bucket };
  if (bucket.includes("/")) {
    const [o, r] = bucket.split("/", 2);
    return { owner: o, repo: r };
  }
  throw new Error(`Cannot resolve bucket repo for ${bucket}: set BUCKET_REPOS or GITHUB_OWNER`);
}
