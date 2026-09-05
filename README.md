# storhub-cdn — S3-Compatible API on Cloudflare Workers backed by GitHub Releases

Cloudflare Worker that exposes an **AWS S3-compatible API** (`PutObject`, `GetObject`, `HeadObject`, `DeleteObject`, `ListObjectsV2`, `CopyObject`, `Multipart Upload`, `Range` etc.) with **GitHub Releases / Tags assets as durable storage**.

> **Design per your spec:**
> - **1 GitHub repo = 1 S3 bucket**
> - **Tag `s3-metadata` (configurable)** holds catalog `index.json` (+ `multipart.json`) — all keys/metadata except raw bytes. GitHub is source-of-truth; KV/Cache is cache-only.
> - **Tags `s3-data-0001`, `s3-data-0002`, …** hold raw bytes chunked as assets. Auto-rotates when a release hits **1000 assets** (GitHub limit). Data releases contain **no metadata**.
> - **Chunking** for > GitHub 2GB limit & Workers limits (default 48 MiB, streaming). Objects are stored as `N` chunk assets; `ETag` is `"md5"` or `"md5-N"` (S3 multipart style).
> - **Streaming** end-to-end: `request.body` → chunked `uploads.github.com` uploads; `GET` concatenates chunk assets via `ReadableStream` without buffering full object.
> - **PAT** auth to GitHub, SigV4 to S3 clients, **custom domain** via Cloudflare route.

---

## Architecture

```
Bucket my-bucket  <-->  GitHub repo owner/my-bucket
  tag s3-metadata       --> Release s3-metadata
        index.json        { version:1, objects: { "a/b.txt": { etag, size, contentType, meta, chunks:[{releaseTag, assetId, assetName, size, offset}] } } }
        multipart.json    { uploadId -> { key, parts:{n:{etag,chunk}} } }
  tag s3-data-0001      --> Release s3-data-0001 (≤1000 assets)
        chk_<uuid>_p000000 , chk_<uuid>_p000001 ...
  tag s3-data-0002      --> Release s3-data-0002
  ...

Client (aws cli / boto3 / rclone / s3cmd) 
  --> Cloudflare Worker (SigV4 verify -> router)
  --> KV_CACHE + caches.default (read-through)
  --> GitHub API (manifest + data)
```

**All data & metadata persisted in GitHub.** `KV_CACHE` (`manifest:owner/repo:s3-metadata`) is **ephemeral cache** (TTL 300s); `caches.default` caches `GET` bodies. Data survives KV purge.

---

## S3 Compatibility

| Tier | Ops | Status |
|------|-----|--------|
| **Bucket** | `CreateBucket` (creates GitHub private repo via PAT, auto-creates `s3-metadata`), `HeadBucket`, `DeleteBucket` (only if empty), `ListBuckets` | ✅ |
| **Object** | `PutObject` (streamed chunking), `GetObject` (Range, `If-*`), `HeadObject`, `DeleteObject`, `DeleteObjects` (POST ?delete), `CopyObject` (`x-amz-copy-source`), `ListObjectsV2` (`prefix/delimiter/max-keys/continuation-token/encoding-type`) | ✅ |
| **Multipart** | `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `ListParts`, `ListMultipartUploads` | ✅ |
| **Other** | `Get/Put Tagging`, `Versioning` (stub `Suspended`), `ACL` (stub `FULL_CONTROL`), `CORS` | Stub (200) |
| **Not** | `Select`, `Object Lock`, `Replication`, `Lifecycle`, true `Versioning`, `Encryption` passthrough | 501/ NotImplemented |

XML error format and `x-amz-request-id` compatible with SDK retries.

---

## Prerequisites

* Cloudflare account + `wrangler` 4.x
* GitHub **fine-grained PAT** (or classic) with:
  * `Contents: Read & Write`, `Metadata: Read`, `Administration: Read & Write` if you want `CreateBucket` to create repos. Or create repos manually.
  * Scope `repo` for private repos.
  * Must have access to `GITHUB_OWNER` org/user.

---

## Setup

```bash
npm install --legacy-peer-deps
cp .dev.vars.example .dev.vars
# edit .dev.vars with your values
npx wrangler dev
```

### `.dev.vars` (local) / `wrangler secret` (production)

```ini
GITHUB_PAT=github_pat_xxx
GITHUB_OWNER=my-org                    # default owner when bucket map not set
BUCKET_REPOS={"my-bucket":"my-org/my-bucket-repo"}  # explicit bucket->repo
METADATA_TAG=s3-metadata
DATA_TAG_PREFIX=s3-data-
CHUNK_SIZE=50331648                    # 48 MiB
S3_ACCESS_KEY=AKIAS3EXAMPLE
S3_SECRET_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
# S3_KEYS_JSON={"AKIA1":"secret1","AKIA2":"secret2"} # alternative multi-key
S3_PUBLIC_READ=false                   # true allows unauth GET/HEAD (CDN mode)
```

Create KV for production:

```bash
npx wrangler kv namespace create KV_CACHE
# paste id into wrangler.jsonc kv_namespaces[0].id
npx wrangler kv namespace create KV_CACHE --preview
```

Secrets for deployed Worker:

```bash
npx wrangler secret put GITHUB_PAT
npx wrangler secret put S3_ACCESS_KEY
npx wrangler secret put S3_SECRET_KEY
# optional
npx wrangler secret put BUCKET_REPOS
```

### Custom Domain (s3.example.com)

1. Add domain to Cloudflare zone.
2. `wrangler.jsonc` routes:
```json
"routes": [
  { "pattern": "s3.example.com/*", "zone_name": "example.com" },
  { "pattern": "*.s3.example.com/*", "zone_name": "example.com" }
]
```
3. `npx wrangler deploy` — Worker serves both:
   * **Path-style**: `https://s3.example.com/my-bucket/key`
   * **Virtual-hosted**: `https://my-bucket.s3.example.com/key`

---

## Usage — AWS Clients

### aws-cli

```bash
aws configure --profile storhub  # AKIA... / secret

aws --endpoint-url https://s3.example.com --profile storhub s3 ls
aws --endpoint-url https://s3.example.com --profile storhub s3 mb s3://my-bucket
aws --endpoint-url https://s3.example.com --profile storhub s3 cp ./big.bin s3://my-bucket/path/big.bin
aws --endpoint-url https://s3.example.com --profile storhub s3api list-objects-v2 --bucket my-bucket --prefix path/
aws --endpoint-url https://s3.example.com --profile storhub s3api head-object --bucket my-bucket --key path/big.bin
```

Presigned URL (validated by Worker):

```bash
aws --endpoint-url https://s3.example.com s3 presign s3://my-bucket/path/big.bin --expires-in 3600
curl -o out.bin "<presigned>"
```

### boto3

```python
import boto3
s3 = boto3.client("s3",
  endpoint_url="https://s3.example.com",
  aws_access_key_id="AKIAS3EXAMPLE",
  aws_secret_access_key="...",
  region_name="us-east-1")
s3.create_bucket(Bucket="my-bucket")
s3.put_object(Bucket="my-bucket", Key="hello.txt", Body=b"hello", ContentType="text/plain", Metadata={"foo":"bar"})
print(s3.get_object(Bucket="my-bucket", Key="hello.txt")["Body"].read())
for page in s3.get_paginator("list_objects_v2").paginate(Bucket="my-bucket", Prefix="h"):
    print(page)
```

### rclone

```ini
# rclone.conf
[storhub]
type = s3
provider = Other
env_auth = false
access_key_id = AKIAS3EXAMPLE
secret_access_key = ...
endpoint = https://s3.example.com
region = us-east-1
force_path_style = true
```

```bash
rclone copy ./local s3:storhub/my-bucket --s3-no-check-bucket
```

### s3cmd

```
s3cmd --host=s3.example.com --host-bucket='%(bucket)s.s3.example.com' --access_key=AKIA... --secret_key=... ls s3://my-bucket
```

---

## Large Files & Multipart

Worker **streams** upload: `PUT` body is read as `ReadableStream`, buffered only to `CHUNK_SIZE` (48 MiB) then immediately `POST` to `uploads.github.com`. No full object in memory.

For files > `CHUNK_SIZE`, `ETag` is S3 multipart form `"hex- N"` (`md5` of binary chunk md5s). `GET Range` works across chunk boundaries.

Multipart (for SDKs that split):

```bash
aws s3api create-multipart-upload --endpoint-url https://s3.example.com --bucket my-bucket --key big.bin
aws s3api upload-part --endpoint-url ... --bucket my-bucket --key big.bin --part-number 1 --upload-id <id> --body part1.bin
aws s3api complete-multipart-upload --endpoint-url ... --bucket my-bucket --key big.bin --upload-id <id> --multipart-upload file://parts.json
```

---

## How Metadata & Sharding Work

* `readManifest(owner,repo,tag)` : `GET /repos/:owner/:repo/releases/tags/:tag` → `GET /releases/:id/assets` → download `index.json`. Cached in `KV_CACHE` with `updated_at`.
* `withManifest(...,mutator)` : optimistic retry loop (5x) — reads manifest, mutates, checks `assetId` still current (race detect), then `DELETE` old `index.json` + `POST` new `index.json`.
* `ensureDataReleaseForUpload` : `GET /releases?per_page=100` → filter `s3-data-*` → sort → `GET /releases/:id/assets` until find `<1000`. Else `POST /releases` to create `s3-data-XXXX`.
* Uploaded chunks are de-duplicated only by manifest; orphan chunks are cleaned on overwrite via `waitUntil`.

---

## Development & Tests

```bash
npm run check      # tsc
npm test           # vitest (unit + mocked e2e)
npm run dev        # wrangler dev local
```

Mocked e2e (`test/e2e.mock.test.ts`) covers `Put/Get/Head/List/Delete`, chunking (5KB shard for test), 1000-asset sharding rotation, copy, multipart, bucket ops without real GitHub.

Live probe (create test repo first):

```bash
# set .dev.vars, then:
npm run dev &
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  aws --endpoint-url http://127.0.0.1:8787 s3 ls
```

---

## Limits & Gotchas

* **GitHub 2GB / asset** hard limit; Worker clamps chunk to ≤90MB (Cloudflare fetch body limit). Objects >2GB require ≥2 chunks.
* **GitHub 1000 assets / release** → shard auto-rotates; listing 100k objects means scanning one `index.json` (30MB for 100k keys) — watch manifest size → shard `index-*.json` if needed (TODO).
* **Rate limits** 5000 req/h / PAT; enable `caches.default` + KV to front.
* **Eventual consistency** on overwrite: concurrent `PUT` same key may race; retry loop mitigates but last write wins.
* **CopyObject** cross-repo re-downloads bytes; same-repo shares chunk references (delete may orphan shared — GC TODO).
* **Private repo** required for `CreateBucket` via PAT without `public_repo`.
* **ToS**: Do not use as mass file host; GitHub may flag abuse. Use private, small buckets.

---

## Deployment

```bash
npx wrangler deploy
# verify
curl https://s3.example.com/_health
curl -u AKIA... https://s3.example.com/my-bucket/_health # not needed
```

Add **Observability** (`observability.enabled`) + check logs `npx wrangler tail`.

## TODO / Extensions

- Shard `index.json` at 50MB to many `index-*.json`
- Garbage-collect orphan chunks via cron `scheduled()`
- Pre-signed `PUT` validation + `Content-MD5`
- Lifecycle & versioning (`versionId` in manifest)
- R2 mirror as L2 cache to cut GitHub egress

```

