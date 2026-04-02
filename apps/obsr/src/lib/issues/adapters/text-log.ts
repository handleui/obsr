import { extractErrors } from "@obsr/extract";
import { scrubSecrets } from "@obsr/types";
import { getAiGatewayApiKey } from "@/lib/env";
import { RouteError } from "@/lib/http";
import { MAX_PERSISTED_RAW_TEXT_CHARS, MAX_RAW_TEXT_CHARS } from "../constants";
import {
  dedupeIssueDiagnostics,
  mapCiErrorToIssueDiagnostic,
  rankIssueDiagnostics,
} from "../normalize";
import type { IssueAdapter } from "./types";

const normalizeRawText = (rawText: string) => {
  return rawText.replace(/\r\n/g, "\n");
};

export const textLogIssueAdapter: IssueAdapter = {
  sourceKinds: ["manual-log", "ci", "runtime-log", "dev-server"],
  normalize: async (input) => {
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

    let extraction: Awaited<ReturnType<typeof extractErrors>>;
    try {
      extraction = await extractErrors(scrubbedRawText, {
        apiKey: getAiGatewayApiKey(),
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message.includes("timed out")
          ? "Issue extraction timed out."
          : "Issue extraction failed.";
      throw new RouteError(502, "INGEST_FAILED", message);
    }

    const diagnostics = rankIssueDiagnostics(
      dedupeIssueDiagnostics(
        extraction.errors.map((error) =>
          mapCiErrorToIssueDiagnostic(error, extraction.detectedSource)
        )
      )
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
      context: input.context,
      capturedAt: new Date(),
      wasRedacted: scrubbedRawText !== rawText,
      wasTruncated: scrubbedRawText.length > MAX_PERSISTED_RAW_TEXT_CHARS,
      diagnostics,
    };
  },
};
