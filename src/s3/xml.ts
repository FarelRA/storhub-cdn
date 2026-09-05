function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function errorXml(code: string, message: string, resource = "", requestId = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${esc(code)}</Code><Message>${esc(message)}</Message><Resource>${esc(resource)}</Resource><RequestId>${esc(requestId)}</RequestId></Error>`;
}

export function listBucketsXml(buckets: { name: string; creationDate: string }[], owner = { id: "storhub", displayName: "storhub" }): string {
  const bXml = buckets
    .map((b) => `<Bucket><Name>${esc(b.name)}</Name><CreationDate>${esc(b.creationDate)}</CreationDate></Bucket>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>${esc(owner.id)}</ID><DisplayName>${esc(owner.displayName)}</DisplayName></Owner><Buckets>${bXml}</Buckets></ListAllMyBucketsResult>`;
}

export function listObjectsV2Xml(params: {
  name: string;
  prefix?: string;
  delimiter?: string;
  maxKeys: number;
  keyCount: number;
  isTruncated: boolean;
  nextContinuationToken?: string;
  continuationToken?: string;
  encodingType?: string;
  commonPrefixes?: string[];
  fetchOwner?: boolean;
  contents: { key: string; lastModified: string; etag: string; size: number; storageClass: string }[];
}): string {
  const common = (params.commonPrefixes || [])
    .map((p) => `<CommonPrefixes><Prefix>${esc(p)}</Prefix></CommonPrefixes>`)
    .join("");
  const contents = params.contents
    .map(
      (c: any) =>
        `<Contents><Key>${esc(c.key)}</Key><LastModified>${esc(c.lastModified)}</LastModified><ETag>${esc(c.etag)}</ETag><Size>${c.size}</Size><StorageClass>${esc(c.storageClass)}</StorageClass>${params.fetchOwner && c.owner ? `<Owner><ID>${esc(c.owner)}</ID></Owner>` : ""}</Contents>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${esc(params.name)}</Name><Prefix>${esc(params.prefix || "")}</Prefix><KeyCount>${params.keyCount}</KeyCount><MaxKeys>${params.maxKeys}</MaxKeys><Delimiter>${esc(params.delimiter || "")}</Delimiter><IsTruncated>${params.isTruncated}</IsTruncated>${params.continuationToken ? `<ContinuationToken>${esc(params.continuationToken)}</ContinuationToken>` : ""}${params.nextContinuationToken ? `<NextContinuationToken>${esc(params.nextContinuationToken)}</NextContinuationToken>` : ""}${params.encodingType ? `<EncodingType>${esc(params.encodingType)}</EncodingType>` : ""}${contents}${common}</ListBucketResult>`;
}

export function deleteObjectsXml(deleted: { key: string }[], errors: { key: string; code: string; message: string }[]): string {
  const d = deleted.map((x) => `<Deleted><Key>${esc(x.key)}</Key></Deleted>`).join("");
  const e = errors.map((x) => `<Error><Key>${esc(x.key)}</Key><Code>${esc(x.code)}</Code><Message>${esc(x.message)}</Message></Error>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${d}${e}</DeleteResult>`;
}

export function createMultipartUploadXml(bucket: string, key: string, uploadId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${esc(bucket)}</Bucket><Key>${esc(key)}</Key><UploadId>${esc(uploadId)}</UploadId></InitiateMultipartUploadResult>`;
}

export function completeMultipartUploadXml(bucket: string, key: string, etag: string, location: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>${esc(location)}</Location><Bucket>${esc(bucket)}</Bucket><Key>${esc(key)}</Key><ETag>${esc(etag)}</ETag></CompleteMultipartUploadResult>`;
}

export function listPartsXml(params: {
  bucket: string;
  key: string;
  uploadId: string;
  parts: { partNumber: number; etag: string; size: number; lastModified: string }[];
  isTruncated: boolean;
  maxParts: number;
  nextPartNumberMarker?: number;
  encodingType?: string;
  partNumberMarker?: number;
  storageClass?: string;
}): string {
  const parts = params.parts
    .map(
      (p) =>
        `<Part><PartNumber>${p.partNumber}</PartNumber><LastModified>${esc(p.lastModified)}</LastModified><ETag>${esc(p.etag)}</ETag><Size>${p.size}</Size></Part>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${esc(params.bucket)}</Bucket><Key>${esc(params.key)}</Key><UploadId>${esc(params.uploadId)}</UploadId><PartNumberMarker>${params.partNumberMarker ?? 0}</PartNumberMarker><NextPartNumberMarker>${params.nextPartNumberMarker ?? 0}</NextPartNumberMarker><MaxParts>${params.maxParts}</MaxParts><IsTruncated>${params.isTruncated}</IsTruncated><StorageClass>${esc(params.storageClass || "STANDARD")}</StorageClass>${params.encodingType ? `<EncodingType>${esc(params.encodingType)}</EncodingType>` : ""}${parts}</ListPartsResult>`;
}

export function listMultipartUploadsXml(params: {
  bucket: string;
  uploads: { key: string; uploadId: string; initiated: string; storageClass: string }[];
  isTruncated: boolean;
  maxUploads: number;
  keyMarker?: string;
  uploadIdMarker?: string;
  nextKeyMarker?: string;
  nextUploadIdMarker?: string;
  prefix?: string;
  delimiter?: string;
}): string {
  const ups = params.uploads
    .map(
      (u) =>
        `<Upload><Key>${esc(u.key)}</Key><UploadId>${esc(u.uploadId)}</UploadId><Initiated>${esc(u.initiated)}</Initiated><StorageClass>${esc(u.storageClass)}</StorageClass></Upload>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${esc(params.bucket)}</Bucket><KeyMarker>${esc(params.keyMarker || "")}</KeyMarker><UploadIdMarker>${esc(params.uploadIdMarker || "")}</UploadIdMarker><NextKeyMarker>${esc(params.nextKeyMarker || "")}</NextKeyMarker><NextUploadIdMarker>${esc(params.nextUploadIdMarker || "")}</NextUploadIdMarker><MaxUploads>${params.maxUploads}</MaxUploads><IsTruncated>${params.isTruncated}</IsTruncated>${params.prefix ? `<Prefix>${esc(params.prefix)}</Prefix>` : ""}${params.delimiter ? `<Delimiter>${esc(params.delimiter)}</Delimiter>` : ""}${ups}</ListMultipartUploadsResult>`;
}

export function tagGetXml(tags: Record<string, string>): string {
  const t = Object.entries(tags)
    .map(([k, v]) => `<Tag><Key>${esc(k)}</Key><Value>${esc(v)}</Value></Tag>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${t}</TagSet></Tagging>`;
}

export function copyObjectXml(etag: string, lastModified: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ETag>${esc(etag)}</ETag><LastModified>${esc(lastModified)}</LastModified></CopyObjectResult>`;
}
