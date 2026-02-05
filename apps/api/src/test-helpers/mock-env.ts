import type { KVNamespace, R2Bucket } from "@cloudflare/workers-types";
import type { Env } from "../types/env";

const createMockKvNamespace = (): KVNamespace => {
  const get = ((key: string | string[], _options?: unknown) => {
    if (Array.isArray(key)) {
      return Promise.resolve(new Map());
    }
    return Promise.resolve(null);
  }) as KVNamespace["get"];

  const getWithMetadata = ((_key: string, _options?: unknown) =>
    Promise.resolve({
      value: null,
      metadata: null,
    })) as KVNamespace["getWithMetadata"];

  const list = ((_options?: unknown) =>
    Promise.resolve({
      keys: [],
      list_complete: true,
      cursor: "",
      cacheStatus: null,
    })) as KVNamespace["list"];

  const put = ((
    _key: string,
    _value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    _options?: unknown
  ) => Promise.resolve(undefined)) as KVNamespace["put"];

  const deleteFn = ((_key: string) =>
    Promise.resolve(undefined)) as KVNamespace["delete"];

  return {
    get,
    getWithMetadata,
    list,
    put,
    delete: deleteFn,
  };
};

const createMockR2Bucket = (): R2Bucket =>
  ({
    put: () => Promise.resolve(null),
    get: () => Promise.resolve(null),
    delete: () => Promise.resolve(undefined),
    list: () =>
      Promise.resolve({ objects: [], truncated: false, delimitedPrefixes: [] }),
    head: () => Promise.resolve(null),
    createMultipartUpload: () => Promise.reject(new Error("not implemented")),
    resumeMultipartUpload: () => {
      throw new Error("not implemented");
    },
  }) as unknown as R2Bucket;

export const createMockEnv = (overrides: Partial<Env> = {}): Env => ({
  GITHUB_APP_ID: "github-app-id",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_APP_PRIVATE_KEY: "github-private-key",
  GITHUB_WEBHOOK_SECRET: "github-webhook-secret",
  WORKOS_CLIENT_ID: "workos-client-id",
  WORKOS_API_KEY: "workos-api-key",
  UPSTASH_REDIS_REST_URL: "https://upstash.test",
  UPSTASH_REDIS_REST_TOKEN: "upstash-token",
  "detent-idempotency": createMockKvNamespace(),
  LOGS_BUCKET: createMockR2Bucket(),
  RESEND_API_KEY: "resend-key",
  RESEND_EMAIL_FROM: "Detent <noreply@detent.dev>",
  NAVIGATOR_BASE_URL: "https://navigator.detent.sh",
  CONVEX_URL: "https://test.convex.cloud",
  CONVEX_SERVICE_TOKEN: "convex-service-token",
  AI_GATEWAY_API_KEY: "ai-gateway-api-key",
  ...overrides,
});

export { createMockKvNamespace as createMockKv };
