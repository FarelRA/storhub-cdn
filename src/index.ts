import { handleS3Request } from "./s3/router";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const scrubbed = new URL(url.toString());
      scrubbed.searchParams.delete("X-Amz-Signature");
      scrubbed.searchParams.delete("X-Amz-Credential");
      scrubbed.searchParams.delete("Signature");
      console.log(`${request.method} ${scrubbed.pathname}${scrubbed.search} Host=${request.headers.get("host")}`);
      const res = await handleS3Request(request, env, ctx);
      // CORS: only wildcard when public read, otherwise echo Origin if allowed
      const origin = request.headers.get("Origin");
      if (env.S3_PUBLIC_READ === "true") {
        res.headers.set("Access-Control-Allow-Origin", "*");
      } else if (origin) {
        // For private buckets, reflect origin only if needed - still allow but credentials required
        res.headers.set("Access-Control-Allow-Origin", origin);
        res.headers.set("Access-Control-Allow-Credentials", "true");
      }
      res.headers.set("Access-Control-Expose-Headers", "ETag, x-amz-request-id, x-amz-version-id, Content-Length, Content-Range");
      return res;
    } catch (e: any) {
      console.error("Unhandled error", e?.stack || e);
      const msg = e?.message || "InternalError";
      const requestId = crypto.randomUUID();
      const safe = msg.replace(/[<>&]/g, (c: string) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c as "<" | ">" | "&"]!));
      const xml = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>${safe}</Message><RequestId>${requestId}</RequestId></Error>`;
      return new Response(xml, { status: 500, headers: { "Content-Type": "application/xml", "x-amz-request-id": requestId } });
    }
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("scheduled GC", event.cron);
    // GC orphan multipart uploads older than 7 days
    try {
      const owner = env.GITHUB_OWNER;
      if (!owner || !env.BUCKET_REPOS) return;
      const buckets = Object.keys(JSON.parse(env.BUCKET_REPOS));
      for (const bucket of buckets) {
        try {
          const { owner: o, repo } = await (await import("./s3/handlers/helpers")).resolveBucketRepo(env, bucket);
          const { readMultipartState, writeMultipartState } = await import("./github/manifest");
          const { uploads, releaseId, assetId } = await readMultipartState(env, o, repo, env.METADATA_TAG || "s3-metadata");
          let changed = false;
          const now = Date.now();
          for (const [id, up] of Object.entries(uploads)) {
            const age = now - new Date(up.initiated).getTime();
            if (age > 7*24*60*60*1000) {
              // delete parts
              for (const part of Object.values(up.parts)) {
                try { const { deleteAsset } = await import("./github/client"); await deleteAsset(env, o, repo, part.chunk.assetId); } catch {}
              }
              delete uploads[id];
              changed = true;
            }
          }
          if (changed) await writeMultipartState(env, o, repo, env.METADATA_TAG || "s3-metadata", uploads, assetId, releaseId);
        } catch {}
      }
    } catch (e) { console.error("GC failed", e); }
  },
};
