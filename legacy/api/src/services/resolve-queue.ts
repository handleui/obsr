import {
  getResolverQueueResolveIds,
  type ResolverQueuePayload,
  type ResolverQueueSource,
} from "@obsr/legacy-types";
import type { Env } from "../types/env";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const buildDeduplicationId = (payload: ResolverQueuePayload): string => {
  const resolveIds = Array.from(new Set(getResolverQueueResolveIds(payload)));
  resolveIds.sort((a, b) => a.localeCompare(b));
  return `${payload.source}:${resolveIds.join(",")}`;
};

const buildPublishUrl = (env: Env): string | null => {
  if (env.UPSTASH_QSTASH_PUBLISH_URL) {
    return env.UPSTASH_QSTASH_PUBLISH_URL.trim() || null;
  }

  if (!env.RESOLVER_WEBHOOK_URL) {
    return null;
  }

  const base = env.UPSTASH_QSTASH_URL?.trim();
  if (!base) {
    return null;
  }

  const destination = encodeURIComponent(env.RESOLVER_WEBHOOK_URL.trim());
  return `${base}/v2/publish/${destination}`;
};

const publishWithRetry = async (
  publishUrl: string,
  payload: ResolverQueuePayload,
  token: string,
  retryAttempt = 0
): Promise<void> => {
  const maxAttempts = 3;
  const payloadJson = JSON.stringify(payload);

  try {
    const response = await fetch(publishUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Upstash-Deduplication-Id": buildDeduplicationId(payload),
      },
      body: payloadJson,
    });

    if (response.ok) {
      return;
    }

    const text = await response.text().catch(() => "");
    if (retryAttempt + 1 >= maxAttempts) {
      throw new Error(
        `qstash publish failed with status ${response.status}: ${text}`
      );
    }

    const delayMs = 250 * 2 ** retryAttempt;
    await sleep(delayMs);
    return publishWithRetry(publishUrl, payload, token, retryAttempt + 1);
  } catch (error) {
    if (retryAttempt + 1 >= maxAttempts) {
      throw error instanceof Error
        ? error
        : new Error(`qstash publish failed: ${String(error)}`);
    }

    const delayMs = 250 * 2 ** retryAttempt;
    await sleep(delayMs);
    return publishWithRetry(publishUrl, payload, token, retryAttempt + 1);
  }
};

export const enqueueResolveForResolver = async (
  env: Env,
  resolveId: string,
  source: ResolverQueueSource = "create"
): Promise<void> => {
  const token = env.UPSTASH_QSTASH_TOKEN?.trim();
  const publishUrl = buildPublishUrl(env);

  if (!(token && publishUrl)) {
    return;
  }

  const payload: ResolverQueuePayload = {
    resolveId,
    source,
  };

  await publishWithRetry(publishUrl, payload, token);
};
