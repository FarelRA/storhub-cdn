import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleS3Request } from "../src/s3/router";
import type { Env } from "../src/types";

// In-memory GitHub mock
type MockRelease = {
  id: number;
  tag_name: string;
  upload_url: string;
  assets: MockAsset[];
};
type MockAsset = {
  id: number;
  name: string;
  size: number;
  content_type: string;
  browser_download_url: string;
  url: string;
  created_at: string;
  updated_at: string;
  _bytes: Uint8Array;
};

let releases: Map<string, MockRelease> = new Map();
let nextReleaseId = 1000;
let nextAssetId = 5000;
let repos: Map<string, { created_at: string }> = new Map();

function resetMock() {
  releases.clear();
  repos.clear();
  nextReleaseId = 1000;
  nextAssetId = 5000;
  // pre-create a repo for bucket "test-bucket"
  repos.set("testowner/test-bucket", { created_at: new Date().toISOString() });
}

function mockFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const parsed = new URL(url);
    const method = (init?.method || (input instanceof Request ? (input as Request).method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers || (input instanceof Request ? (input as Request).headers : {}));
    // We also need to extract body
    let bodyBytes: Uint8Array | null = null;
    if (init?.body) {
      if (init.body instanceof Uint8Array) bodyBytes = init.body;
      else if (init.body instanceof ArrayBuffer) bodyBytes = new Uint8Array(init.body);
      else if (typeof init.body === "string") bodyBytes = new TextEncoder().encode(init.body);
      else {
        // ReadableStream? Not in mock body for upload we handle via ArrayBuffer path mostly
        bodyBytes = new Uint8Array(0);
      }
    }

    // console.log(`[mockFetch] ${method} ${parsed.hostname}${parsed.pathname}${parsed.search}`);

    // API: GET /user -> authenticated user
    if (parsed.hostname === "api.github.com" && parsed.pathname === "/user" && method === "GET") {
      return new Response(JSON.stringify({ login: "testowner" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // repos
    const repoMatch = parsed.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (repoMatch && parsed.hostname === "api.github.com") {
      const owner = repoMatch[1];
      const repo = repoMatch[2];
      const suffix = repoMatch[3] || "";
      const repoKey = `${owner}/${repo}`;

      // GET /repos/{owner}/{repo}  -> repo info
      if (suffix === "" && method === "GET") {
        const r = repos.get(repoKey);
        if (!r) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ name: repo, full_name: repoKey, created_at: r.created_at }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      // POST /repos/{owner}/repos or /user/repos for create? For simplicity, creation is POST /user/repos or /orgs/{org}/repos
      // Handle /repos/{owner}/{repo}/releases
      if (suffix === "/releases" && method === "POST") {
        // create release
        const bodyTxt = bodyBytes ? new TextDecoder().decode(bodyBytes) : "";
        let bodyJson: any = {};
        try { bodyJson = JSON.parse(bodyTxt); } catch {}
        const tag = bodyJson.tag_name;
        const key = `${repoKey}:${tag}`;
        if (releases.has(key)) {
          return new Response(JSON.stringify({ message: "already exists" }), { status: 422 });
        }
        const rel: MockRelease = {
          id: nextReleaseId++,
          tag_name: tag,
          upload_url: `https://uploads.github.com/repos/${owner}/${repo}/releases/${nextReleaseId - 1}/assets{?name,label}`,
          assets: [],
        };
        releases.set(key, rel);
        return new Response(
          JSON.stringify({
            id: rel.id,
            tag_name: rel.tag_name,
            name: tag,
            upload_url: rel.upload_url,
            assets: [],
            created_at: new Date().toISOString(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      // GET /releases/tags/{tag}
      const tagMatch = suffix.match(/^\/releases\/tags\/(.+)$/);
      if (tagMatch && method === "GET") {
        const tag = decodeURIComponent(tagMatch[1]);
        const key = `${repoKey}:${tag}`;
        const rel = releases.get(key);
        if (!rel) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        return new Response(
          JSON.stringify({
            id: rel.id,
            tag_name: rel.tag_name,
            name: rel.tag_name,
            upload_url: rel.upload_url,
            assets: rel.assets.map((a) => ({ id: a.id, name: a.name, label: null, size: a.size, content_type: a.content_type, browser_download_url: a.browser_download_url, url: a.url, created_at: a.created_at, updated_at: a.updated_at })),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // GET /releases/{id}
      const relIdMatch = suffix.match(/^\/releases\/(\d+)$/);
      if (relIdMatch && method === "GET") {
        const id = parseInt(relIdMatch[1], 10);
        for (const rel of releases.values()) {
          if (rel.id === id) {
            return new Response(
              JSON.stringify({
                id: rel.id,
                tag_name: rel.tag_name,
                upload_url: rel.upload_url,
                assets: rel.assets.map((a) => ({ id: a.id, name: a.name, size: a.size })),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }
        return new Response("not found", { status: 404 });
      }
      // GET /releases/{id}/assets
      const assetsMatch = suffix.match(/^\/releases\/(\d+)\/assets$/);
      if (assetsMatch && method === "GET") {
        const id = parseInt(assetsMatch[1], 10);
        const perPage = parseInt(parsed.searchParams.get("per_page") || "30", 10);
        const page = parseInt(parsed.searchParams.get("page") || "1", 10);
        for (const rel of releases.values()) {
          if (rel.id === id) {
            const start = (page - 1) * perPage;
            const slice = rel.assets.slice(start, start + perPage);
            const out = slice.map((a) => ({
              id: a.id,
              name: a.name,
              label: null,
              size: a.size,
              content_type: a.content_type,
              browser_download_url: a.browser_download_url,
              url: a.url,
              created_at: a.created_at,
              updated_at: a.updated_at,
            }));
            return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
          }
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      // GET /releases  (list)
      if (suffix === "/releases" && method === "GET") {
        const perPage = parseInt(parsed.searchParams.get("per_page") || "30", 10);
        const page = parseInt(parsed.searchParams.get("page") || "1", 10);
        const all = Array.from(releases.values()).filter((r) => {
          // only releases for this repo? releases keys include repoKey
          // But releases map includes all repos, need to filter by repoKey prefix
          // We stored key as repoKey:tag, so need to find those
          for (const k of releases.keys()) if (k.startsWith(`${repoKey}:`) && releases.get(k)?.id === r.id) return true;
          return false;
        });
        // simpler: iterate releases map keys
        const list: MockRelease[] = [];
        for (const [k, v] of releases.entries()) if (k.startsWith(`${repoKey}:`)) list.push(v);
        const start = (page - 1) * perPage;
        const slice = list.slice(start, start + perPage);
        const out = slice.map((r) => ({ id: r.id, tag_name: r.tag_name, upload_url: r.upload_url, assets: r.assets.slice(0, 0) }));
        return new Response(JSON.stringify(out), { status: 200 });
      }
      // DELETE /releases/assets/{assetId}
      const delAssetMatch = suffix.match(/^\/releases\/assets\/(\d+)$/);
      if (delAssetMatch && method === "DELETE") {
        const aid = parseInt(delAssetMatch[1], 10);
        for (const rel of releases.values()) {
          const idx = rel.assets.findIndex((a) => a.id === aid);
          if (idx !== -1) {
            rel.assets.splice(idx, 1);
            return new Response(null, { status: 204 });
          }
        }
        return new Response("not found", { status: 404 });
      }
      // GET /releases/assets/{assetId}  -> download
      if (delAssetMatch && method === "GET") {
        const aid = parseInt(delAssetMatch[1], 10);
        for (const rel of releases.values()) {
          const a = rel.assets.find((x) => x.id === aid);
          if (a) {
            const accept = headers.get("accept") || "";
            // return bytes
            return new Response(a._bytes as any, {
              status: 200,
              headers: { "Content-Type": a.content_type, "Content-Length": String(a.size) },
            });
          }
        }
        return new Response("not found", { status: 404 });
      }
    }

    // Org/User repo creation
    if (parsed.hostname === "api.github.com" && (parsed.pathname === "/user/repos" || parsed.pathname.match(/^\/orgs\/[^/]+\/repos$/)) && method === "POST") {
      const bodyTxt = bodyBytes ? new TextDecoder().decode(bodyBytes) : "";
      let bodyJson: any = {};
      try { bodyJson = JSON.parse(bodyTxt); } catch {}
      const repoName = bodyJson.name;
      // Determine owner from path
      let owner = "testowner";
      const orgMatch = parsed.pathname.match(/^\/orgs\/([^/]+)\/repos$/);
      if (orgMatch) owner = orgMatch[1];
      else {
        // fetch authenticated user login earlier -> testowner
      }
      const repoKey = `${owner}/${repoName}`;
      repos.set(repoKey, { created_at: new Date().toISOString() });
      return new Response(JSON.stringify({ name: repoName, full_name: repoKey, created_at: new Date().toISOString() }), { status: 201, headers: { "Content-Type": "application/json" } });
    }

    // uploads.github.com
    if (parsed.hostname === "uploads.github.com" && method === "POST") {
      const m = parsed.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/releases\/(\d+)\/assets$/);
      if (m) {
        const owner = m[1];
        const repo = m[2];
        const relId = parseInt(m[3], 10);
        const name = parsed.searchParams.get("name") || "unnamed";
        // find release
        let target: MockRelease | null = null;
        for (const r of releases.values()) if (r.id === relId) target = r;
        if (!target) return new Response("release not found", { status: 404 });
        if (target.assets.length >= 1000) return new Response("too many assets", { status: 422 });
        // content-type from headers
        const ct = headers.get("content-type") || "application/octet-stream";
        // bodyBytes is available? For uploadAssetBytes we sent Uint8Array via init.body
        // For ReadableStream we would have not captured correctly; in test we send arrayBuffer so bytes present
        // But handle case where input is Request with body
        let bytes = bodyBytes;
        if (!bytes && input instanceof Request) {
          const ab = await (input as Request).arrayBuffer().catch(() => null);
          if (ab) bytes = new Uint8Array(ab);
        }
        if (!bytes) bytes = new Uint8Array(0);
        // If bodyBytes null and we have no bytes but request had streaming, we need to read input body
        const id = nextAssetId++;
        const now = new Date().toISOString();
        const asset: MockAsset = {
          id,
          name,
          size: bytes.length,
          content_type: ct,
          browser_download_url: `https://github.com/${owner}/${repo}/releases/download/${target.tag_name}/${name}`,
          url: `https://api.github.com/repos/${owner}/${repo}/releases/assets/${id}`,
          created_at: now,
          updated_at: now,
          _bytes: bytes,
        };
        target.assets.push(asset);
        return new Response(
          JSON.stringify({
            id: asset.id,
            name: asset.name,
            size: asset.size,
            content_type: asset.content_type,
            browser_download_url: asset.browser_download_url,
            url: asset.url,
            created_at: asset.created_at,
            updated_at: asset.updated_at,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // Fallback: not mocked
    console.warn(`mockFetch unhandled ${method} ${url}`);
    return new Response(JSON.stringify({ message: `mock not implemented for ${method} ${parsed.pathname}` }), { status: 404 });
  }) as unknown as typeof fetch;
}

function createEnv(): Env {
  const store = new Map<string, string>();
  const kv: any = {
    async get(key: string, type: string) {
      const v = store.get(key);
      if (!v) return null;
      if (type === "json") return JSON.parse(v);
      return v;
    },
    async put(key: string, value: string, opts?: any) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  return {
    GITHUB_PAT: "test_pat",
    GITHUB_OWNER: "testowner",
    BUCKET_REPOS: JSON.stringify({ "test-bucket": "testowner/test-bucket" }),
    METADATA_TAG: "s3-metadata",
    DATA_TAG_PREFIX: "s3-data-",
    CHUNK_SIZE: String(5 * 1024), // 5KB for testing chunking easily
    S3_PUBLIC_READ: "true",
    KV_CACHE: kv,
  } as unknown as Env;
}

async function s3Request(env: Env, method: string, path: string, opts: { headers?: Record<string, string>; body?: Uint8Array | string | null; query?: string } = {}): Promise<Response> {
  const url = `https://s3.example.com${path}${opts.query || ""}`;
  const headers = new Headers(opts.headers || {});
  // ensure host
  headers.set("host", "s3.example.com");
  let body: BodyInit | null = null;
  if (opts.body instanceof Uint8Array) body = opts.body as any;
  else if (typeof opts.body === "string") body = opts.body;
  else body = opts.body as any;
  const req = new Request(url, { method, headers, body: body as any });
  const ctx = { waitUntil: (p: Promise<any>) => p, passThroughOnException: () => {} } as unknown as ExecutionContext;
  return handleS3Request(req, env, ctx);
}

describe("e2e mock S3 over GitHub", () => {
  let env: Env;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    resetMock();
    env = createEnv();
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch() as any;
  });

  it("full CRUD: put/get/head/list/delete", async () => {
    // Put object
    const body = new TextEncoder().encode("hello world");
    let res = await s3Request(env, "PUT", "/test-bucket/hello.txt", { body, headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(200);
    const etag = res.headers.get("ETag");
    expect(etag).toBeTruthy();

    // Get object
    res = await s3Request(env, "GET", "/test-bucket/hello.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(etag);
    const txt = await res.text();
    expect(txt).toBe("hello world");

    // Head object
    res = await s3Request(env, "HEAD", "/test-bucket/hello.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("11");

    // List objects v2
    res = await s3Request(env, "GET", "/test-bucket", { query: "?list-type=2" });
    expect(res.status).toBe(200);
    const xmlBody = await res.text();
    expect(xmlBody).toContain("hello.txt");
    expect(xmlBody).toContain("<KeyCount>1</KeyCount>");

    // Put second object
    const body2 = new TextEncoder().encode("second");
    res = await s3Request(env, "PUT", "/test-bucket/folder/nested.txt", { body: body2 });
    expect(res.status).toBe(200);

    // List with prefix
    res = await s3Request(env, "GET", "/test-bucket", { query: "?list-type=2&prefix=folder/" });
    const xml2 = await res.text();
    expect(xml2).toContain("folder/nested.txt");
    expect(xml2).not.toContain("hello.txt");

    // List with delimiter
    res = await s3Request(env, "GET", "/test-bucket", { query: "?list-type=2&delimiter=/" });
    const xml3 = await res.text();
    expect(xml3).toContain("<CommonPrefixes><Prefix>folder/</Prefix></CommonPrefixes>");
    // Should contain hello.txt as Contents, but folder/nested.txt collapsed

    // Range GET
    res = await s3Request(env, "GET", "/test-bucket/hello.txt", { headers: { Range: "bytes=0-4" } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("Content-Range")).toBe("bytes 0-4/11");

    // Delete
    res = await s3Request(env, "DELETE", "/test-bucket/hello.txt");
    expect(res.status).toBe(204);
    // Get after delete -> 404
    res = await s3Request(env, "GET", "/test-bucket/hello.txt");
    expect(res.status).toBe(404);
  });

  it("chunking: large file split across assets", async () => {
    // CHUNK_SIZE is 5KB, make 12KB file => 3 chunks
    const large = new Uint8Array(12 * 1024);
    for (let i = 0; i < large.length; i++) large[i] = i % 256;
    let res = await s3Request(env, "PUT", "/test-bucket/large.bin", { body: large, headers: { "content-type": "application/octet-stream" } });
    expect(res.status).toBe(200);
    const etag = res.headers.get("ETag");
    expect(etag).toContain("-3"); // multipart etag

    // Get full
    res = await s3Request(env, "GET", "/test-bucket/large.bin");
    expect(res.status).toBe(200);
    const out = new Uint8Array(await res.arrayBuffer());
    expect(out.length).toBe(large.length);
    expect(out).toEqual(large);

    // Range across chunk boundary (e.g., 4000-7000 crosses 5KB boundary)
    res = await s3Request(env, "GET", "/test-bucket/large.bin", { headers: { Range: "bytes=4096-6143" } });
    expect(res.status).toBe(206);
    const slice = new Uint8Array(await res.arrayBuffer());
    expect(slice.length).toBe(2048);
    expect(slice[0]).toBe(4096 % 256);
  });

  it("sharding: sequential data releases when hitting 1000", async () => {
    // For testing, we lower limit conceptually? But our mock enforces 1000. We can't create 1000 uploads in test (too slow)
    // Instead we manually fill a release to 999 and test next upload creates new tag
    // Pre-fill s3-data-0001 with 999 dummy assets
    // Create release directly via mock
    // Use internal releases map
    // Ensure data prefix handling
    // Create 999 assets in s3-data-0001
    // For speed, we will directly manipulate releases map to simulate fullness

    // First, ensure metadata release exists via a put
    let res = await s3Request(env, "PUT", "/test-bucket/seed.txt", { body: new TextEncoder().encode("x") });
    expect(res.status).toBe(200);
    // Now find s3-data-0001 release in mock
    const key = "testowner/test-bucket:s3-data-0001";
    let rel = releases.get(key);
    expect(rel).toBeTruthy();
    // Fill to 1000 by pushing dummy assets
    if (rel) {
      while (rel.assets.length < 1000) {
        rel.assets.push({
          id: nextAssetId++,
          name: `dummy_${rel.assets.length}`,
          size: 1,
          content_type: "text/plain",
          browser_download_url: "",
          url: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          _bytes: new Uint8Array([0]),
        });
      }
    }
    // Now upload new object should create s3-data-0002
    res = await s3Request(env, "PUT", "/test-bucket/next.txt", { body: new TextEncoder().encode("next") });
    expect(res.status).toBe(200);
    const hasNewShard = releases.has("testowner/test-bucket:s3-data-0002");
    expect(hasNewShard).toBe(true);
  });

  it("copy object", async () => {
    let res = await s3Request(env, "PUT", "/test-bucket/src.txt", { body: new TextEncoder().encode("source content") });
    expect(res.status).toBe(200);
    res = await s3Request(env, "PUT", "/test-bucket/dest.txt", { headers: { "x-amz-copy-source": "/test-bucket/src.txt" } });
    expect(res.status).toBe(200);
    res = await s3Request(env, "GET", "/test-bucket/dest.txt");
    expect(await res.text()).toBe("source content");
  });

  it("multipart upload flow", async () => {
    // Create
    let res = await s3Request(env, "POST", "/test-bucket/big.mp4", { query: "?uploads" });
    expect(res.status).toBe(200);
    const xmlBody = await res.text();
    const m = xmlBody.match(/<UploadId>(.*?)<\/UploadId>/);
    expect(m).toBeTruthy();
    const uploadId = m![1];

    // Upload part 1
    const part1 = new Uint8Array(6 * 1024);
    part1.fill(1);
    res = await s3Request(env, "PUT", "/test-bucket/big.mp4", { query: `?partNumber=1&uploadId=${uploadId}`, body: part1 });
    expect(res.status).toBe(200);
    const etag1 = res.headers.get("ETag")!;

    // Upload part 2
    const part2 = new Uint8Array(6 * 1024);
    part2.fill(2);
    res = await s3Request(env, "PUT", "/test-bucket/big.mp4", { query: `?partNumber=2&uploadId=${uploadId}`, body: part2 });
    expect(res.status).toBe(200);
    const etag2 = res.headers.get("ETag")!;

    // List parts
    res = await s3Request(env, "GET", "/test-bucket/big.mp4", { query: `?uploadId=${uploadId}` });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<PartNumber>1</PartNumber>");

    // Complete
    const completeXml = `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag1}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>${etag2}</ETag></Part></CompleteMultipartUpload>`;
    res = await s3Request(env, "POST", "/test-bucket/big.mp4", { query: `?uploadId=${uploadId}`, body: new TextEncoder().encode(completeXml), headers: { "content-type": "application/xml" } });
    expect(res.status).toBe(200);
    // Get object should be concatenated
    res = await s3Request(env, "GET", "/test-bucket/big.mp4");
    expect(res.status).toBe(200);
    const out = new Uint8Array(await res.arrayBuffer());
    expect(out.length).toBe(12 * 1024);
    expect(out[0]).toBe(1);
    expect(out[7 * 1024]).toBe(2);
  });

  it("list buckets and bucket ops", async () => {
    let res = await s3Request(env, "GET", "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("test-bucket");

    res = await s3Request(env, "HEAD", "/test-bucket");
    expect(res.status).toBe(200);

    // Create new bucket (auto creates repo)
    res = await s3Request(env, "PUT", "/new-bucket");
    expect(res.status).toBe(200);
    // Need to add to BUCKET_REPOS for future? But createRepo mock will create repo; however handleS3Request doesn't auto-update env map, but ListBuckets currently reads env map not repos list, so new bucket won't appear unless added to env
    // For now check repo exists via mock
    expect(repos.has("testowner/new-bucket")).toBe(true);
  });
});
