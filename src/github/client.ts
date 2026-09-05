import type { Env, GitHubAsset, GitHubRelease } from "../types";

const API_BASE = "https://api.github.com";
const UPLOAD_BASE = "https://uploads.github.com";

function ghHeaders(env: Env, extra: Record<string, string> = {}): Headers {
  const h = new Headers({
    Authorization: `Bearer ${env.GITHUB_PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "storhub-cdn/0.1",
    ...extra,
  });
  return h;
}

async function ghFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
  base = API_BASE,
): Promise<Response> {
  const url = `${base}${path}`;
  const headers = ghHeaders(env, (init.headers as Record<string, string>) || {});
  const reqHeaders = new Headers(headers);
  if (init.headers) {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      reqHeaders.set(k, v);
    }
  }
  // Retry on 429 / 5xx with exponential backoff (up to 3 retries)
  let attempt = 0;
  while (true) {
    const res = await fetch(url, { ...init, headers: reqHeaders });
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      if (attempt >= 3) return res;
      const retryAfter = res.headers.get("retry-after");
      const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 500 * Math.pow(2, attempt) + Math.random() * 200;
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
      continue;
    }
    return res;
  }
}

export async function getReleaseByTag(
  env: Env,
  owner: string,
  repo: string,
  tag: string,
): Promise<GitHubRelease | null> {
  const res = await ghFetch(env, `/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`getReleaseByTag ${tag} failed ${res.status}: ${txt}`);
  }
  return (await res.json()) as GitHubRelease;
}

export async function getReleaseById(
  env: Env,
  owner: string,
  repo: string,
  id: number,
): Promise<GitHubRelease> {
  const res = await ghFetch(env, `/repos/${owner}/${repo}/releases/${id}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`getReleaseById ${id} failed ${res.status}: ${txt}`);
  }
  return (await res.json()) as GitHubRelease;
}

export async function createRelease(
  env: Env,
  owner: string,
  repo: string,
  tag: string,
  name?: string,
  body?: string,
  target_commitish?: string,
): Promise<GitHubRelease> {
  const payload: any = {
    tag_name: tag,
    name: name || tag,
    body: body || `S3 storage shard ${tag}`,
    draft: false,
    prerelease: false,
    generate_release_notes: false,
  };
  if (target_commitish) payload.target_commitish = target_commitish;
  let res = await ghFetch(env, `/repos/${owner}/${repo}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    // Fallback for empty repo: create initial commit then retry
    if (res.status === 422 && txt.includes("commit")) {
      try {
        await ghFetch(env, `/repos/${owner}/${repo}/contents/README.md`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "init",
            content: "IyBTdG9ySHViIENETgo=", // "# StorHub CDN"
          }),
        });
        res = await ghFetch(env, `/repos/${owner}/${repo}/releases`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) return (await res.json()) as GitHubRelease;
      } catch {}
    }
    throw new Error(`createRelease ${tag} failed ${res.status}: ${txt}`);
  }
  return (await res.json()) as GitHubRelease;
}

export async function ensureRelease(env: Env, owner: string, repo: string, tag: string): Promise<GitHubRelease> {
  let rel = await getReleaseByTag(env, owner, repo, tag);
  if (rel) return rel;
  try {
    rel = await createRelease(env, owner, repo, tag);
    return rel;
  } catch (e: any) {
    const msg = String(e?.message || "");
    // Only retry on 422 (already exists race), not on 403/401
    if (msg.includes("422")) {
      const again = await getReleaseByTag(env, owner, repo, tag);
      if (again) return again;
    }
    throw e;
  }
}

export async function listReleaseAssets(
  env: Env,
  owner: string,
  repo: string,
  releaseId: number,
  perPage = 100,
  page = 1,
): Promise<GitHubAsset[]> {
  const res = await ghFetch(env, `/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=${perPage}&page=${page}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`listReleaseAssets ${releaseId} failed ${res.status}: ${txt}`);
  }
  return (await res.json()) as GitHubAsset[];
}

export async function listAllReleaseAssets(
  env: Env,
  owner: string,
  repo: string,
  releaseId: number,
): Promise<GitHubAsset[]> {
  let page = 1;
  const all: GitHubAsset[] = [];
  while (true) {
    const batch = await listReleaseAssets(env, owner, repo, releaseId, 100, page);
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

// List releases to discover shards; paginated up to 100 per page
export async function listReleases(env: Env, owner: string, repo: string, perPage = 100, page = 1): Promise<GitHubRelease[]> {
  const res = await ghFetch(env, `/repos/${owner}/${repo}/releases?per_page=${perPage}&page=${page}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`listReleases failed ${res.status}: ${txt}`);
  }
  return (await res.json()) as GitHubRelease[];
}

export async function listAllReleases(env: Env, owner: string, repo: string): Promise<GitHubRelease[]> {
  let page = 1;
  const all: GitHubRelease[] = [];
  while (true) {
    const batch = await listReleases(env, owner, repo, 100, page);
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

export async function uploadAsset(
  env: Env,
  owner: string,
  repo: string,
  releaseId: number,
  name: string,
  body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
  contentType = "application/octet-stream",
  label?: string,
): Promise<GitHubAsset> {
  // GitHub upload URL: https://uploads.github.com/repos/{owner}/{repo}/releases/{release_id}/assets{?name,label}
  const qs = new URLSearchParams({ name });
  if (label) qs.set("label", label);
  const path = `/repos/${owner}/${repo}/releases/${releaseId}/assets?${qs.toString()}`;
  // body can be stream; need to handle Content-Length if known
  // For ArrayBuffer/Uint8Array we can set length; for stream chunked
  const headers: Record<string, string> = {
    "Content-Type": contentType,
  };
  let fetchBody: BodyInit | null = null;
  if (body instanceof ReadableStream) {
    fetchBody = body as unknown as BodyInit;
    // Workers fetch requires duplex: half for streaming
    // @ts-ignore duplex is not in TS but supported in workers
  } else if (body instanceof Uint8Array) {
    fetchBody = body as unknown as BodyInit;
  } else if (body instanceof ArrayBuffer) {
    fetchBody = new Uint8Array(body);
  } else {
    fetchBody = body as BodyInit;
  }

  const init: RequestInit & { duplex?: string } = {
    method: "POST",
    headers,
    body: fetchBody as BodyInit,
    // @ts-ignore
    duplex: "half",
  };
  const res = await ghFetch(env, path, init, UPLOAD_BASE);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`uploadAsset ${name} to ${releaseId} failed ${res.status}: ${txt}`);
  }
  return (await res.json()) as GitHubAsset;
}

export async function uploadAssetBytes(
  env: Env,
  owner: string,
  repo: string,
  releaseId: number,
  name: string,
  bytes: Uint8Array,
  contentType = "application/octet-stream",
): Promise<GitHubAsset> {
  return uploadAsset(env, owner, repo, releaseId, name, bytes, contentType);
}

export async function deleteAsset(env: Env, owner: string, repo: string, assetId: number): Promise<void> {
  const res = await ghFetch(env, `/repos/${owner}/${repo}/releases/assets/${assetId}`, {
    method: "DELETE",
  });
  if (res.status === 404) return;
  if (!res.ok && res.status !== 204) {
    const txt = await res.text();
    throw new Error(`deleteAsset ${assetId} failed ${res.status}: ${txt}`);
  }
}

export async function deleteRelease(env: Env, owner: string, repo: string, releaseId: number): Promise<void> {
  // Fetch tag before delete to avoid 404 after
  let tagName: string | null = null;
  try {
    const rel = await getReleaseById(env, owner, repo, releaseId);
    tagName = rel.tag_name;
  } catch {}
  const res = await ghFetch(env, `/repos/${owner}/${repo}/releases/${releaseId}`, { method: "DELETE" });
  if (res.status === 404) return;
  if (!res.ok && res.status !== 204) {
    const txt = await res.text();
    throw new Error(`deleteRelease ${releaseId} failed ${res.status}: ${txt}`);
  }
  if (tagName) {
    try {
      await ghFetch(env, `/repos/${owner}/${repo}/git/refs/tags/${tagName}`, {
        method: "DELETE",
      });
    } catch {}
  }
}

export async function downloadAsset(
  env: Env,
  owner: string,
  repo: string,
  assetId: number,
  range?: string,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/octet-stream" };
  if (range) headers["Range"] = range;
  const res = await ghFetch(env, `/repos/${owner}/${repo}/releases/assets/${assetId}`, {
    headers,
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (loc) {
      const s3Headers: Record<string, string> = {};
      if (range) s3Headers["Range"] = range;
      const s3Res = await fetch(loc, { headers: s3Headers, redirect: "follow" });
      if (!s3Res.ok && s3Res.status !== 206) {
        const txt = await s3Res.text().catch(() => "");
        throw new Error(`downloadAsset redirect ${assetId} failed ${s3Res.status}: ${txt}`);
      }
      return s3Res;
    }
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`downloadAsset ${assetId} failed ${res.status}: ${txt}`);
  }
  return res;
}

export async function getRepo(env: Env, owner: string, repo: string): Promise<any | null> {
  const res = await ghFetch(env, `/repos/${owner}/${repo}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`getRepo ${owner}/${repo} failed ${res.status}: ${txt}`);
  }
  return await res.json();
}

export async function createRepo(env: Env, owner: string, repo: string, isOrg: boolean, description = "StorHub CDN bucket"): Promise<any> {
  const payload: any = { name: repo, description, private: true, auto_init: true };
  let path = "/user/repos";
  if (isOrg) path = `/orgs/${owner}/repos`;
  // Heuristic: if owner != authenticated user, try org first then user
  // We need authenticated user login; fetch /user
  const res = await ghFetch(env, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`createRepo ${owner}/${repo} failed ${res.status}: ${txt}`);
  }
  return await res.json();
}

export async function getAuthenticatedUser(env: Env): Promise<{ login: string }> {
  const res = await ghFetch(env, "/user");
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`getAuthenticatedUser failed ${res.status}: ${txt}`);
  }
  return (await res.json()) as { login: string };
}
