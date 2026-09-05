export interface Env {
  GITHUB_PAT: string;
  GITHUB_OWNER?: string;
  BUCKET_REPOS?: string;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  S3_KEYS_JSON?: string;
  CHUNK_SIZE?: string;
  METADATA_TAG?: string;
  DATA_TAG_PREFIX?: string;
  S3_PUBLIC_READ?: string;
  CUSTOM_DOMAIN?: string;
  KV_CACHE?: KVNamespace;
}

export type Chunk = {
  releaseTag: string;
  assetId: number;
  assetName: string;
  size: number;
  offset?: number; // deprecated, computed from size sums
};

export type ObjectMeta = {
  tags?: Record<string, string>;
  key: string;
  size: number;
  etag: string;
  contentType: string;
  contentEncoding?: string;
  contentDisposition?: string;
  lastModified: string; // ISO
  storageClass: string;
  meta: Record<string, string>; // x-amz-meta-*
  chunks: Chunk[];
  versionId?: string;
  cacheControl?: string;
  expires?: string;
};

export type Manifest = {
  version: 1;
  bucket: string;
  objects: Record<string, ObjectMeta>;
  uploads?: Record<string, MultipartUpload>;
};

export type MultipartUpload = {
  uploadId: string;
  key: string;
  initiated: string;
  contentType: string;
  meta: Record<string, string>;
  parts: Record<number, { etag: string; size: number; chunk: Chunk }>;
};

export type S3ErrorCode =
  | "NoSuchBucket"
  | "NoSuchKey"
  | "BucketAlreadyExists"
  | "BucketNotEmpty"
  | "AccessDenied"
  | "SignatureDoesNotMatch"
  | "InvalidRequest"
  | "EntityTooLarge"
  | "NoSuchUpload"
  | "InvalidPart"
  | "NotImplemented";

export interface BucketMapping {
  owner: string;
  repo: string;
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string;
  assets: GitHubAsset[];
  upload_url: string;
  html_url: string;
}

export interface GitHubAsset {
  id: number;
  name: string;
  label: string | null;
  size: number;
  content_type: string;
  created_at: string;
  updated_at: string;
  browser_download_url: string;
  url: string;
}
