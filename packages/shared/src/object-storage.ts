// Object storage for delivery snapshots — node-only (S3 SDK). Kept OUT of the
// package index so the browser bundles never pull aws-sdk; api + worker import
// it via "@guestpost/shared/dist/object-storage".
//
// Dev: MinIO (S3-compatible, forcePathStyle). Prod: Cloudflare R2 (S3 API).
// Same code path — only env differs. Snapshots are write-once and retained
// permanently (legal/dispute evidence).
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

let client: S3Client | null = null
let bucket = ""

// Resolve config from env. MINIO_* for dev, R2/S3_* for prod. Endpoint set =>
// path-style addressing (MinIO/R2 both need it).
function getClient(): { client: S3Client; bucket: string } {
  if (client) return { client, bucket }

  const endpoint =
    process.env.S3_ENDPOINT ??
    process.env.R2_ENDPOINT ??
    (process.env.MINIO_ENDPOINT
      ? `http://${process.env.MINIO_ENDPOINT}`
      : undefined)
  const accessKeyId =
    process.env.S3_ACCESS_KEY ??
    process.env.R2_ACCESS_KEY_ID ??
    process.env.MINIO_ACCESS_KEY ??
    ""
  const secretAccessKey =
    process.env.S3_SECRET_KEY ??
    process.env.R2_SECRET_ACCESS_KEY ??
    process.env.MINIO_SECRET_KEY ??
    ""
  bucket =
    process.env.S3_BUCKET ??
    process.env.R2_BUCKET ??
    process.env.MINIO_BUCKET ??
    "guestpost"

  client = new S3Client({
    region: process.env.S3_REGION ?? "auto",
    endpoint,
    forcePathStyle: !!endpoint, // MinIO + R2 require path-style
    credentials: { accessKeyId, secretAccessKey },
  })
  return { client, bucket }
}

export interface PutResult {
  objectKey: string
}

// Store an object permanently. Key is caller-supplied (deterministic, e.g.
// deliveries/<versionId>/page.html) so writes are idempotent on retry.
export async function putObject(
  objectKey: string,
  body: string | Buffer,
  contentType: string,
): Promise<PutResult> {
  const { client, bucket } = getClient()
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    }),
  )
  return { objectKey }
}

// Presigned GET for UI download (finance/dispute evidence). Default 15m TTL.
export async function presignGet(
  objectKey: string,
  expiresInSeconds = 900,
): Promise<string> {
  const { client, bucket } = getClient()
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
    {
      expiresIn: expiresInSeconds,
    },
  )
}

// Test/DI seam — reset the memoized client (used by unit tests).
export function __resetStorageClient() {
  client = null
  bucket = ""
}
