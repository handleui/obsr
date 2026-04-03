import { isResponsesRequestError } from "@obsr/ai";
import {
  dedupeIssueDiagnostics,
  extractIssueDiagnostics,
  rankIssueDiagnostics,
  sanitizeIssueObservationContext,
  scrubUnknown,
} from "@obsr/issues";
import { scrubSecrets } from "@obsr/types";
import { getResponsesApiConfig } from "@/lib/env";
import { RouteError } from "@/lib/http";
import { MAX_PERSISTED_RAW_TEXT_CHARS, MAX_RAW_TEXT_CHARS } from "../constants";
import type { IssueAdapter } from "./types";

const normalizeRawText = (rawText: string) => {
  return rawText.replace(/\r\n/g, "\n");
};

const toExtractionFailure = (error: unknown) => {
  if (!isResponsesRequestError(error)) {
    return {
      status: 502,
      code: "INGEST_FAILED",
      message: "Issue extraction failed.",
    };
  }

  if (error.kind === "input_too_large") {
    return {
      status: 413,
      code: "INPUT_TOO_LARGE",
      message: "Issue extraction input exceeded the model context limit.",
    };
  }

  if (error.kind === "timed_out") {
    return {
      status: 502,
      code: "INGEST_FAILED",
      message: "Issue extraction timed out.",
    };
  }

  if (error.kind === "incomplete") {
    return {
      status: 502,
      code: "INGEST_FAILED",
      message: "Issue extraction hit the token limit.",
    };
  }

  if (error.kind === "refused") {
    return {
      status: 502,
      code: "INGEST_FAILED",
      message: "Issue extraction was refused.",
    };
  }

  if (error.kind === "transient") {
    return {
      status: 503,
      code: "INGEST_UNAVAILABLE",
      message: "Issue extraction is temporarily unavailable.",
    };
  }

  return {
    status: 502,
    code: "INGEST_FAILED",
    message: "Issue extraction failed.",
  };
};

export const textLogIssueAdapter: IssueAdapter = {
  sourceKinds: ["manual-log", "ci", "runtime-log", "dev-server"],
  normalize: async (input, aiContext) => {
    const rawText = normalizeRawText(input.rawText ?? "");

    if (!rawText.trim()) {
      throw new RouteError(
        400,
        "EMPTY_INPUT",
        "Paste raw text before creating an issue."
      );
    }

    if (rawText.length > MAX_RAW_TEXT_CHARS) {
      throw new RouteError(
        413,
        "INPUT_TOO_LARGE",
        `Raw input exceeds the ${MAX_RAW_TEXT_CHARS.toLocaleString()} character limit.`
      );
    }

    const scrubbedRawText = scrubSecrets(rawText);

    let extraction: Awaited<ReturnType<typeof extractIssueDiagnostics>>;
    try {
      extraction = await extractIssueDiagnostics(scrubbedRawText, {
        ...getResponsesApiConfig(),
        promptCacheKey: aiContext?.promptCacheKey,
        safetyIdentifier: aiContext?.safetyIdentifier,
      });
    } catch (error) {
      const failure = toExtractionFailure(error);
      throw new RouteError(failure.status, failure.code, failure.message);
    }

    const diagnostics = rankIssueDiagnostics(
      dedupeIssueDiagnostics(extraction.diagnostics)
    );

    if (diagnostics.length === 0) {
      throw new RouteError(
        422,
        "NO_DIAGNOSTICS",
        "No actionable diagnostics were found in the raw input."
      );
    }

    return {
      sourceKind: input.sourceKind,
      rawText: scrubbedRawText.slice(0, MAX_PERSISTED_RAW_TEXT_CHARS),
      rawPayload: scrubUnknown(input.rawPayload),
      dedupeKey: input.dedupeKey,
      context: sanitizeIssueObservationContext(input.context),
      capturedAt: input.capturedAt ? new Date(input.capturedAt) : new Date(),
      wasRedacted: scrubbedRawText !== rawText,
      wasTruncated: scrubbedRawText.length > MAX_PERSISTED_RAW_TEXT_CHARS,
      diagnostics,
    };
  },
};
