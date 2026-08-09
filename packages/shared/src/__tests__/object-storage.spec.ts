import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3"
import {
  __resetStorageClient,
  assertObjectStorageReady,
  OBJECT_STORAGE_READINESS_SENTINEL_KEY,
  presignGet,
  resolveObjectStorageConfig,
} from "../object-storage"

const MINIO_ENV = {
  MINIO_ENDPOINT: "localhost:9000",
  MINIO_ACCESS_KEY: "local-access",
  MINIO_SECRET_KEY: "local-secret",
  MINIO_BUCKET: "guestpost-test",
}

const R2_ENV = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ENDPOINT:
    "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "r2-access",
  R2_SECRET_ACCESS_KEY: "r2-secret",
  R2_BUCKET: "guestpost-evidence",
}

const S3_ENV = {
  S3_ENDPOINT: "https://objects.example.com",
  S3_ACCESS_KEY: "s3-access",
  S3_SECRET_KEY: "s3-secret",
  S3_BUCKET: "guestpost-s3",
  S3_REGION: "us-east-1",
}

describe("object storage configuration", () => {
  const originalEnv = process.env

  afterEach(() => {
    process.env = originalEnv
    __resetStorageClient()
    jest.restoreAllMocks()
  })

  it("uses only MinIO in development even when external credentials coexist", () => {
    expect(
      resolveObjectStorageConfig({
        NODE_ENV: "development",
        ...MINIO_ENV,
        ...R2_ENV,
        ...S3_ENV,
      }),
    ).toEqual({
      provider: "minio",
      endpoint: "http://localhost:9000",
      region: "us-east-1",
      bucket: "guestpost-test",
      accessKeyId: "local-access",
      secretAccessKey: "local-secret",
      forcePathStyle: true,
    })
  })

  it.each([
    "r2",
    "s3",
  ])("rejects explicit %s selection in development", (provider) => {
    expect(() =>
      resolveObjectStorageConfig({
        NODE_ENV: "development",
        OBJECT_STORAGE_PROVIDER: provider,
        ...MINIO_ENV,
        ...R2_ENV,
        ...S3_ENV,
      }),
    ).toThrow("OBJECT_STORAGE_PROVIDER must be minio")
  })

  it("requires an explicit production provider and never falls back to MinIO", () => {
    expect(() =>
      resolveObjectStorageConfig({
        NODE_ENV: "production",
        OBJECT_STORAGE_PROVIDER: "minio",
        ...MINIO_ENV,
      }),
    ).toThrow("explicitly set to r2 or s3")

    expect(() =>
      resolveObjectStorageConfig({
        NODE_ENV: "production",
        ...MINIO_ENV,
      }),
    ).toThrow("explicitly set to r2 or s3")
  })

  it("resolves a production R2 bundle without borrowing S3 or MinIO fields", () => {
    expect(
      resolveObjectStorageConfig({
        NODE_ENV: "production",
        OBJECT_STORAGE_PROVIDER: "r2",
        ...MINIO_ENV,
        ...R2_ENV,
        ...S3_ENV,
      }),
    ).toEqual({
      provider: "r2",
      endpoint:
        "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "guestpost-evidence",
      accessKeyId: "r2-access",
      secretAccessKey: "r2-secret",
      forcePathStyle: true,
    })
  })

  it("rejects a partial provider bundle without exposing or borrowing secrets", () => {
    let message = ""
    try {
      resolveObjectStorageConfig({
        NODE_ENV: "production",
        OBJECT_STORAGE_PROVIDER: "r2",
        R2_ACCOUNT_ID: R2_ENV.R2_ACCOUNT_ID,
        R2_ENDPOINT: R2_ENV.R2_ENDPOINT,
        R2_ACCESS_KEY_ID: R2_ENV.R2_ACCESS_KEY_ID,
        R2_BUCKET: R2_ENV.R2_BUCKET,
        MINIO_SECRET_KEY: "must-not-leak-or-borrow",
        S3_SECRET_KEY: "also-must-not-leak-or-borrow",
      })
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain("R2_SECRET_ACCESS_KEY")
    expect(message).not.toContain("must-not-leak-or-borrow")
  })

  it.each([
    {
      accountId: "not-a-valid-account-id",
      endpoint: R2_ENV.R2_ENDPOINT,
    },
    {
      accountId: R2_ENV.R2_ACCOUNT_ID,
      endpoint:
        "https://ffffffffffffffffffffffffffffffff.r2.cloudflarestorage.com",
    },
    {
      accountId: R2_ENV.R2_ACCOUNT_ID,
      endpoint: `${R2_ENV.R2_ENDPOINT}:8443`,
    },
  ])("rejects an unbound R2 account endpoint %#", ({ accountId, endpoint }) => {
    expect(() =>
      resolveObjectStorageConfig({
        NODE_ENV: "production",
        OBJECT_STORAGE_PROVIDER: "r2",
        ...R2_ENV,
        R2_ACCOUNT_ID: accountId,
        R2_ENDPOINT: endpoint,
      }),
    ).toThrow(/R2_ACCOUNT_ID|canonical endpoint/)
  })

  it("resolves S3 atomically and requires its region", () => {
    expect(
      resolveObjectStorageConfig({
        NODE_ENV: "production",
        OBJECT_STORAGE_PROVIDER: "s3",
        ...S3_ENV,
      }),
    ).toMatchObject({
      provider: "s3",
      endpoint: "https://objects.example.com",
      region: "us-east-1",
      forcePathStyle: true,
    })

    expect(() =>
      resolveObjectStorageConfig({
        NODE_ENV: "production",
        OBJECT_STORAGE_PROVIDER: "s3",
        S3_ACCESS_KEY: S3_ENV.S3_ACCESS_KEY,
        S3_SECRET_KEY: S3_ENV.S3_SECRET_KEY,
        S3_BUCKET: S3_ENV.S3_BUCKET,
      }),
    ).toThrow("S3_REGION")
  })

  it.each([
    "https://storage.example.com",
    "https://localhost:9000",
    "http://localhost:9999",
    "http://user:password@localhost:9000",
    "http://localhost:9000/path",
  ])("rejects unsafe development endpoint %s", (endpoint) => {
    expect(() =>
      resolveObjectStorageConfig({
        NODE_ENV: "development",
        ...MINIO_ENV,
        MINIO_ENDPOINT: endpoint,
      }),
    ).toThrow(/MINIO_ENDPOINT|local MinIO/)
  })

  it.each([
    "-leading",
    "trailing-",
    "192.168.1.1",
    "name..gap",
  ])("rejects invalid bucket name %s", (bucket) => {
    expect(() =>
      resolveObjectStorageConfig({
        NODE_ENV: "development",
        ...MINIO_ENV,
        MINIO_BUCKET: bucket,
      }),
    ).toThrow("invalid MINIO_BUCKET")
  })

  it("rejects ambiguous runtime environments", () => {
    expect(() =>
      resolveObjectStorageConfig({ NODE_ENV: "staging", ...MINIO_ENV }),
    ).toThrow("NODE_ENV must be development, test, or production")
  })

  it("presigns a local MinIO URL without making a network request", async () => {
    process.env = {
      NODE_ENV: "test",
      ...MINIO_ENV,
      ...R2_ENV,
      ...S3_ENV,
    }

    const signed = new URL(
      await presignGet("deliveries/version-1/page.html", 60),
    )

    expect(signed.origin).toBe("http://localhost:9000")
    expect(signed.pathname).toBe(
      "/guestpost-test/deliveries/version-1/page.html",
    )
  })

  it("performs a bounded read-only readiness check against the fixed sentinel", async () => {
    const send = jest
      .spyOn(S3Client.prototype, "send")
      .mockResolvedValue({} as never)
    const destroy = jest.spyOn(S3Client.prototype, "destroy")

    await expect(
      assertObjectStorageReady({ NODE_ENV: "test", ...MINIO_ENV }, 100),
    ).resolves.toEqual({ provider: "minio" })

    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0]?.[0]
    expect(command).toBeInstanceOf(HeadObjectCommand)
    expect((command as HeadObjectCommand).input).toEqual({
      Bucket: MINIO_ENV.MINIO_BUCKET,
      Key: OBJECT_STORAGE_READINESS_SENTINEL_KEY,
    })
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it("fails closed when the sentinel cannot be read without leaking secrets", async () => {
    jest.spyOn(S3Client.prototype, "send").mockImplementation(() => {
      throw new Error("upstream included local-secret")
    })
    const destroy = jest.spyOn(S3Client.prototype, "destroy")

    let message = ""
    try {
      await assertObjectStorageReady({ NODE_ENV: "test", ...MINIO_ENV }, 100)
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toBe("Object storage readiness check failed for minio")
    expect(message).not.toContain(MINIO_ENV.MINIO_SECRET_KEY)
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
