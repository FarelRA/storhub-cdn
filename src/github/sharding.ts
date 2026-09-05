import type { Env, GitHubRelease } from "../types";
import { ensureRelease, getReleaseByTag, listAllReleases, listAllReleaseAssets } from "./client";

export function dataTagName(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(4, "0")}`;
}

export function parseDataTagIndex(tag: string, prefix: string): number | null {
  if (!tag.startsWith(prefix)) return null;
  const suffix = tag.slice(prefix.length);
  if (!/^\d{4}$/.test(suffix)) return null;
  const n = parseInt(suffix, 10);
  if (Number.isNaN(n)) return null;
  return n;
}

export async function findNextDataRelease(
  env: Env,
  owner: string,
  repo: string,
  prefix: string,
): Promise<{ release: GitHubRelease; index: number }> {
  const all = await listAllReleases(env, owner, repo);
  const dataReleases = all
    .map((r) => ({ release: r, idx: parseDataTagIndex(r.tag_name, prefix) }))
    .filter((x) => x.idx !== null) as { release: GitHubRelease; idx: number }[];
  dataReleases.sort((a, b) => a.idx - b.idx);

  // Find first non-full shard in ascending order to avoid gaps, else lowest gap
  const existingIdxs = new Set(dataReleases.map((d) => d.idx));
  // Check existing shards for capacity, prefer lowest index with space
  for (const cand of dataReleases) {
    const assets = await listAllReleaseAssets(env, owner, repo, cand.release.id);
    if (assets.length < 1000) {
      return { release: cand.release, index: cand.idx };
    }
  }
  // All full or none exists -> find smallest missing index (gap fill) else max+1
  let nextIdx = 1;
  while (existingIdxs.has(nextIdx)) nextIdx++;
  // If no gaps but all full, next is max+1; above while already gives that when no gaps
  if (dataReleases.length > 0 && existingIdxs.size === dataReleases.length && nextIdx <= Math.max(...existingIdxs)) {
    nextIdx = Math.max(...existingIdxs) + 1;
  }
  const tag = dataTagName(prefix, nextIdx);
  const rel = await ensureRelease(env, owner, repo, tag);
  return { release: rel, index: nextIdx };
}

export async function ensureDataReleaseForUpload(
  env: Env,
  owner: string,
  repo: string,
  prefix: string,
): Promise<GitHubRelease> {
  // Retry loop for race where shard fills between find and upload
  for (let attempt = 0; attempt < 3; attempt++) {
    const { release } = await findNextDataRelease(env, owner, repo, prefix);
    const assets = await listAllReleaseAssets(env, owner, repo, release.id);
    if (assets.length < 1000) return release;
    // If still full (race), loop to find next
    await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
  }
  const { release } = await findNextDataRelease(env, owner, repo, prefix);
  return release;
}

export async function getDataReleaseByTag(
  env: Env,
  owner: string,
  repo: string,
  tag: string,
): Promise<GitHubRelease | null> {
  return getReleaseByTag(env, owner, repo, tag);
}
