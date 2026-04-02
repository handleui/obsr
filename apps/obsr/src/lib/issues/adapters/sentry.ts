import { RouteError } from "@/lib/http";
import { createIssueDiagnosticDraft, scrubUnknown } from "../normalize";
import type { IssueAdapter } from "./types";

interface SentryExceptionValue {
  type?: string;
  value?: string;
  stacktrace?: {
    frames?: Array<{
      filename?: string;
      lineno?: number;
      colno?: number;
      in_app?: boolean;
    }>;
  };
}

interface SentryPayload {
  title?: string;
  message?: string;
  level?: string;
  culprit?: string;
  event_id?: string;
  url?: string;
  platform?: string;
  exception?: {
    values?: SentryExceptionValue[];
  };
}

const toSentryPayload = (value: unknown): SentryPayload => {
  if (!value || typeof value !== "object") {
    throw new RouteError(
      400,
      "INVALID_SENTRY_PAYLOAD",
      "Sentry observations require a JSON object payload."
    );
  }

  return value as SentryPayload;
};

const getPrimaryException = (payload: SentryPayload) => {
  return payload.exception?.values?.[0];
};

const getPrimaryFrame = (payload: SentryPayload) => {
  const frames = getPrimaryException(payload)?.stacktrace?.frames ?? [];
  return [...frames].reverse().find((frame) => frame.in_app) ?? frames.at(-1);
};

const mapSeverity = (level?: string) => {
  if (!level) {
    return "error" as const;
  }

  if (["warning", "info", "debug", "log"].includes(level.toLowerCase())) {
    return "warning" as const;
  }

  return "error" as const;
};

export const sentryIssueAdapter: IssueAdapter = {
  sourceKinds: ["sentry"],
  normalize: (input) => {
    const payload = toSentryPayload(scrubUnknown(input.rawPayload));
    const primaryException = getPrimaryException(payload);
    const primaryFrame = getPrimaryFrame(payload);
    const message =
      payload.title?.trim() ||
      payload.message?.trim() ||
      primaryException?.value?.trim() ||
      "Sentry runtime failure";
    const evidence = JSON.stringify(
      {
        title: payload.title,
        message: payload.message,
        level: payload.level,
        culprit: payload.culprit,
        platform: payload.platform,
        exception: primaryException,
      },
      null,
      2
    );

    return Promise.resolve({
      sourceKind: "sentry",
      rawPayload: payload,
      context: {
        ...input.context,
        provider: input.context.provider ?? "sentry",
        externalId: input.context.externalId ?? payload.event_id,
        externalUrl: input.context.externalUrl ?? payload.url,
      },
      capturedAt: new Date(),
      wasRedacted: JSON.stringify(payload) !== JSON.stringify(input.rawPayload),
      wasTruncated: false,
      diagnostics: [
        createIssueDiagnosticDraft({
          message,
          severity: mapSeverity(payload.level),
          category: "runtime",
          source: "sentry",
          ruleId: primaryException?.type ?? null,
          filePath: primaryFrame?.filename ?? payload.culprit ?? null,
          line: primaryFrame?.lineno ?? null,
          column: primaryFrame?.colno ?? null,
          evidence,
        }),
      ],
    });
  },
};
