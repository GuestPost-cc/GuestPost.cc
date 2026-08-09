// Object storage for delivery snapshots — node-only (S3 SDK). Kept OUT of the
// package index so the browser bundles never pull aws-sdk; api + worker import
// it via "@guestpost/shared/dist/object-storage".
//
// Dev/test: local MinIO. Production: an explicitly selected Cloudflare R2 or
// S3 provider. Snapshots are write-once and retained permanently
// (legal/dispute evidence).
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

export const OBJECT_STORAGE_READINESS_SENTINEL_KEY =
  ".guestpost/evidence-storage-ready-v1"

let client: S3Client | null = null
let bucket = ""

type ObjectStorageEnv = Readonly<Record<string, string | undefined>>

export interface ObjectStorageConfig {
  provider: "minio" | "r2" | "s3"
  endpoint?: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

function required(env: ObjectStorageEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) {
    throw new Error(`Object storage configuration is missing ${key}`)
  }
  return value
}

function validateBucketName(value: string, key: string): string {
  if (
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) ||
    value.includes("..") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) ||
    /^(?:xn--|sthree-|amzn-s3-demo-)/.test(value) ||
    /(?:-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(value)
  ) {
    throw new Error(`Object storage configuration has an invalid ${key}`)
  }
  return value
}

function parseEndpoint(
  rawValue: string,
  key: string,
  options: { localOnly: boolean; requireHttps: boolean },
): string {
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(rawValue)
    ? rawValue
    : `http://${rawValue}`
  let parsed: URL
  try {
    parsed = new URL(withProtocol)
  } catch {
    throw new Error(`Object storage configuration has an invalid ${key}`)
  }

  const cleanPath = parsed.pathname === "" || parsed.pathname === "/"
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    !cleanPath ||
    parsed.search ||
    parsed.hash ||
    (options.requireHttps && parsed.protocol !== "https:")
  ) {
    throw new Error(`Object storage configuration has an invalid ${key}`)
  }

  if (
    options.localOnly &&
    (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
      parsed.protocol !== "http:" ||
      parsed.port !== "9000")
  ) {
    throw new Error(
      `${key} must target the local MinIO service on HTTP port 9000`,
    )
  }

  return parsed.toString().replace(/\/$/, "")
}

function resolveR2Endpoint(env: ObjectStorageEnv): string {
  const accountId = required(env, "R2_ACCOUNT_ID").toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(accountId)) {
    throw new Error("Object storage configuration has an invalid R2_ACCOUNT_ID")
  }

  const endpoint = parseEndpoint(required(env, "R2_ENDPOINT"), "R2_ENDPOINT", {
    localOnly: false,
    requireHttps: true,
  })
  const expectedEndpoint = `https://${accountId}.r2.cloudflarestorage.com`
  if (endpoint !== expectedEndpoint) {
    throw new Error(
      "R2_ENDPOINT must be the canonical endpoint for R2_ACCOUNT_ID",
    )
  }
  return endpoint
}

/**
 * Resolve one atomic provider configuration. Fields are never borrowed from a
 * different provider, so a partial secret set cannot silently redirect or
 * authenticate an evidence write elsewhere.
 */
export function resolveObjectStorageConfig(
  env: ObjectStorageEnv = process.env,
): ObjectStorageConfig {
  const nodeEnv = required(env, "NODE_ENV")
  const configuredProvider = env.OBJECT_STORAGE_PROVIDER?.trim().toLowerCase()

  if (nodeEnv === "development" || nodeEnv === "test") {
    if (configuredProvider && configuredProvider !== "minio") {
      throw new Error(
        "OBJECT_STORAGE_PROVIDER must be minio outside production",
      )
    }
    return {
      provider: "minio",
      endpoint: parseEndpoint(
        required(env, "MINIO_ENDPOINT"),
        "MINIO_ENDPOINT",
        {
          localOnly: true,
          requireHttps: false,
        },
      ),
      region: "us-east-1",
      bucket: validateBucketName(required(env, "MINIO_BUCKET"), "MINIO_BUCKET"),
      accessKeyId: required(env, "MINIO_ACCESS_KEY"),
      secretAccessKey: required(env, "MINIO_SECRET_KEY"),
      forcePathStyle: true,
    }
  }

  if (nodeEnv !== "production") {
    throw new Error(
      "NODE_ENV must be development, test, or production for object storage",
    )
  }
  if (configuredProvider !== "r2" && configuredProvider !== "s3") {
    throw new Error(
      "Production OBJECT_STORAGE_PROVIDER must be explicitly set to r2 or s3",
    )
  }

  if (configuredProvider === "r2") {
    return {
      provider: "r2",
      endpoint: resolveR2Endpoint(env),
      region: "auto",
      bucket: validateBucketName(required(env, "R2_BUCKET"), "R2_BUCKET"),
      accessKeyId: required(env, "R2_ACCESS_KEY_ID"),
      secretAccessKey: required(env, "R2_SECRET_ACCESS_KEY"),
      forcePathStyle: true,
    }
  }

  const endpoint = env.S3_ENDPOINT?.trim()
  return {
    provider: "s3",
    endpoint: endpoint
      ? parseEndpoint(endpoint, "S3_ENDPOINT", {
          localOnly: false,
          requireHttps: true,
        })
      : undefined,
    region: required(env, "S3_REGION"),
    bucket: validateBucketName(required(env, "S3_BUCKET"), "S3_BUCKET"),
    accessKeyId: required(env, "S3_ACCESS_KEY"),
    secretAccessKey: required(env, "S3_SECRET_KEY"),
    forcePathStyle: Boolean(endpoint),
  }
}

function createClient(config: ObjectStorageConfig): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
}

/**
 * Verify that the configured credential can read a fixed, operator-provisioned
 * object before a process starts accepting work. This check is deliberately
 * read-only: production application startup must never create buckets or
 * manufacture evidence-store readiness.
 */
export async function assertObjectStorageReady(
  env: ObjectStorageEnv = process.env,
  timeoutMs = 5_000,
): Promise<{ provider: ObjectStorageConfig["provider"] }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "Object storage readiness timeout must be a positive integer",
    )
  }

  const config = resolveObjectStorageConfig(env)
  const readinessClient = createClient(config)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()

  try {
    await readinessClient.send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: OBJECT_STORAGE_READINESS_SENTINEL_KEY,
      }),
      { abortSignal: controller.signal },
    )
    return { provider: config.provider }
  } catch {
    // Provider errors can contain request or endpoint diagnostics. Do not
    // retain them as a cause because bootstrap exceptions are reported to
    // logs/Sentry and must never carry credential-adjacent material.
    throw new Error(
      `Object storage readiness check failed for ${config.provider}`,
    )
  } finally {
    clearTimeout(timeout)
    readinessClient.destroy()
  }
}

function getClient(): { client: S3Client; bucket: string } {
  if (client) return { client, bucket }

  const config = resolveObjectStorageConfig()
  bucket = config.bucket

  client = createClient(config)
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
    client as any,
    new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
    {
      expiresIn: expiresInSeconds,
    },
  )
}

// Test/DI seam — reset the memoized client (used by unit tests).
export function __resetStorageClient() {
  client?.destroy()
  client = null
  bucket = ""
}
