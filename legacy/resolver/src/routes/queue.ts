import { Buffer } from "node:buffer";
import { parseResolverQueuePayload } from "@obsr/legacy-types";
import type { Context } from "hono";
import { Hono } from "hono";
import { jwtVerify } from "jose";
import { env } from "../env.js";
import { enqueueResolves } from "../services/worker/index.js";

const normalizeSubjectCandidates = (requestUrl: string): string[] => {
  const normalize = (candidate: string): string[] => {
    const trimmed = candidate.trim();
    if (!trimmed) {
      return [];
    }
    if (trimmed.endsWith("/")) {
      return [trimmed, trimmed.slice(0, -1)];
    }
    return [trimmed, `${trimmed}/`];
  };

  const candidates = [
    ...normalize(env.RESOLVER_WEBHOOK_URL ?? requestUrl),
    ...normalize(requestUrl),
  ];

  return [...new Set(candidates)];
};

const toBase64Url = (bytes: Uint8Array): string => {
  return Buffer.from(bytes).toString("base64url");
};

const computeBodyHash = async (body: string): Promise<string> => {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body)
  );
  return toBase64Url(new Uint8Array(hash));
};

const getQstashSigningKeys = (): string[] =>
  [
    env.QSTASH_CURRENT_SIGNING_KEY,
    env.QSTASH_NEXT_SIGNING_KEY,
    env.UPSTASH_QSTASH_CURRENT_SIGNING_KEY,
    env.UPSTASH_QSTASH_NEXT_SIGNING_KEY,
  ]
    .filter((key): key is string => typeof key === "string")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

const verifyQueuedRequest = async (
  rawBody: string,
  requestUrl: string,
  signingKeys: string[],
  signatureHeader: string | undefined
): Promise<boolean> => {
  if (!signatureHeader) {
    return false;
  }

  const bodyHash = await computeBodyHash(rawBody);
  const expectedSubjects = normalizeSubjectCandidates(requestUrl);

  for (const signingKey of signingKeys) {
    const signingKeyBytes = new TextEncoder().encode(signingKey);

    for (const subject of expectedSubjects) {
      try {
        const verified = await jwtVerify(signatureHeader, signingKeyBytes, {
          issuer: "Upstash",
          subject,
          algorithms: ["HS256"],
        });

        if (
          typeof verified.payload.body === "string" &&
          verified.payload.body === bodyHash
        ) {
          return true;
        }
      } catch {
        // Ignore signature mismatch for this key/subject candidate.
      }
    }
  }

  return false;
};

const parseQueuePayload = (rawBody: string) => {
  try {
    return parseResolverQueuePayload(JSON.parse(rawBody));
  } catch {
    return null;
  }
};

const app = new Hono();

const enqueueHandler = async (c: Context) => {
  const rawBody = await c.req.text();
  if (!rawBody) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const signingKeys = getQstashSigningKeys();
  if (signingKeys.length === 0) {
    return c.json(
      { error: "Resolver queue signing keys are not configured" },
      503
    );
  }

  if (
    !(await verifyQueuedRequest(
      rawBody,
      c.req.url,
      signingKeys,
      c.req.header("Upstash-Signature")
    ))
  ) {
    return c.json({ error: "Invalid queue request signature" }, 401);
  }

  const body = parseQueuePayload(rawBody);
  if (body === null) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  try {
    const result = await enqueueResolves(body);
    if (result.accepted.length === 0) {
      if (result.skipped.length === 0) {
        return c.json(
          {
            error: "Resolver queue received no valid resolve IDs",
            accepted: result.accepted,
            skipped: result.skipped,
          },
          400
        );
      }

      return c.json(
        {
          accepted: result.accepted,
          skipped: result.skipped,
          warning: "All resolves were skipped due to concurrency/availability",
        },
        200
      );
    }

    if (result.skipped.length > 0) {
      return c.json({
        accepted: result.accepted,
        skipped: result.skipped,
        warning: "Some resolves were skipped due to concurrency/availability",
      });
    }

    return c.json({
      accepted: result.accepted,
      skipped: result.skipped,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Resolver worker is not running"
    ) {
      return c.json(
        {
          error: "Resolver queue not ready",
          accepted: [],
          skipped: [],
        },
        503
      );
    }

    return c.json(
      {
        error: "Failed to enqueue resolves",
        details: error instanceof Error ? error.message : String(error),
        accepted: [],
        skipped: [],
      },
      500
    );
  }
};

app.post("/resolves", enqueueHandler);

export default app;
