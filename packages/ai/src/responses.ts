import OpenAI from "openai";
import type { AutoParseableTextFormat } from "openai/lib/parser";
import { normalizeModelId } from "./client.js";
import { estimateCost } from "./pricing.js";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_SMART_MODEL,
  DEFAULT_TIMEOUT_MS,
  type ResponseUsageSummary,
} from "./types.js";

export const AI_GATEWAY_RESPONSES_BASE_URL = "https://ai-gateway.vercel.sh/v1";
export const responsesRoutingModes = ["openai", "gateway"] as const;
export const responsesErrorKinds = [
  "failed",
  "incomplete",
  "input_too_large",
  "refused",
  "timed_out",
  "transient",
] as const;
export const reasoningEffortValues = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

const INPUT_TOO_LARGE_PATTERN =
  /context length|maximum context|input too large|request too large|prompt is too long|too many input tokens|token limit/i;

export type ReasoningEffort = (typeof reasoningEffortValues)[number];
export type ResponsesRoutingMode = (typeof responsesRoutingModes)[number];
export type ResponsesErrorKind = (typeof responsesErrorKinds)[number];
export type StructuredTextFormat<T> = AutoParseableTextFormat<T>;

export interface ResponsesRuntimeOptions {
  apiKey: string;
  baseURL?: string;
  routingMode?: ResponsesRoutingMode;
  model?: string;
  maxOutputTokens?: number;
  timeout?: number;
  promptCacheKey?: string;
  safetyIdentifier?: string;
  store?: boolean;
  abortSignal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
}

export class ResponsesRequestError extends Error {
  readonly kind: ResponsesErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    {
      kind,
      status,
      code,
      type,
      retryable = false,
    }: {
      kind: ResponsesErrorKind;
      status?: number;
      code?: string;
      type?: string;
      retryable?: boolean;
    }
  ) {
    super(message);
    this.name = "ResponsesRequestError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.type = type;
    this.retryable = retryable;
  }
}

export interface RawResponsesRequest<T> {
  system: string;
  prompt: string;
  textFormat: StructuredTextFormat<T>;
}

export const isResponsesRequestError = (
  error: unknown
): error is ResponsesRequestError => {
  return error instanceof ResponsesRequestError;
};

export const isAiGatewayBaseUrl = (baseURL?: string) => {
  if (!baseURL) {
    return false;
  }

  try {
    return new URL(baseURL).host === "ai-gateway.vercel.sh";
  } catch {
    return false;
  }
};

const stripOpenAiPrefix = (modelId: string) => {
  return modelId.startsWith("openai/")
    ? modelId.slice("openai/".length)
    : modelId;
};

const resolveRoutingMode = ({
  routingMode,
  baseURL,
}: Pick<ResponsesRuntimeOptions, "routingMode" | "baseURL">) => {
  if (routingMode) {
    return routingMode;
  }

  return isAiGatewayBaseUrl(baseURL) ? "gateway" : "openai";
};

export const resolveResponsesModel = ({
  model,
  baseURL,
  routingMode,
}: Pick<ResponsesRuntimeOptions, "model" | "baseURL" | "routingMode">) => {
  const modelId = normalizeModelId(model ?? DEFAULT_SMART_MODEL);
  if (resolveRoutingMode({ routingMode, baseURL }) === "gateway") {
    return modelId;
  }

  if (modelId.includes("/") && !modelId.startsWith("openai/")) {
    throw new Error(
      "Direct Responses API requests require an OpenAI model. Configure AI Gateway to route provider-prefixed model IDs."
    );
  }

  return stripOpenAiPrefix(modelId);
};

export const createResponsesAbortSignal = (
  timeout = DEFAULT_TIMEOUT_MS,
  abortSignal?: AbortSignal
) => {
  const timeoutSignal = AbortSignal.timeout(timeout);
  return abortSignal
    ? AbortSignal.any([abortSignal, timeoutSignal])
    : timeoutSignal;
};

export const createResponsesClient = ({
  apiKey,
  baseURL,
}: ResponsesRuntimeOptions) => {
  return new OpenAI({
    apiKey,
    baseURL,
  });
};

export const getResponsesMaxOutputTokens = (maxOutputTokens?: number) => {
  return maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
};

const getOutputItems = (response: { output?: unknown }) => {
  return Array.isArray(response.output) ? response.output : [];
};

const getContentEntries = (value: unknown) => {
  if (!value || typeof value !== "object") {
    return [];
  }

  const content = (value as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
};

const getOutputEntries = (response: { output?: unknown }) => {
  return getOutputItems(response).flatMap((item) => getContentEntries(item));
};

const readOutputText = (response: { output?: unknown }) => {
  for (const entry of getOutputEntries(response)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    if ((entry as { type?: unknown }).type !== "output_text") {
      continue;
    }

    const text = (entry as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      return text;
    }
  }

  return null;
};

const readRefusalText = (response: { output?: unknown; refusal?: unknown }) => {
  if (typeof response.refusal === "string" && response.refusal.trim()) {
    return response.refusal.trim();
  }

  for (const entry of getOutputEntries(response)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const refusal = (entry as { refusal?: unknown }).refusal;
    if (typeof refusal === "string" && refusal.trim()) {
      return refusal.trim();
    }
  }

  return null;
};

const getIncompleteReason = (response: {
  status?: unknown;
  incomplete_details?: unknown;
}) => {
  if (response.status !== "incomplete") {
    return null;
  }

  const details = response.incomplete_details;
  if (!details || typeof details !== "object") {
    return "unknown";
  }

  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason : "unknown";
};

const assertStructuredOutputReady = (response: {
  output?: unknown;
  refusal?: unknown;
  status?: unknown;
  incomplete_details?: unknown;
}) => {
  const refusal = readRefusalText(response);
  if (refusal) {
    throw new Error(`Structured output refused: ${refusal}`);
  }

  const incompleteReason = getIncompleteReason(response);
  if (incompleteReason) {
    throw new Error(`Structured output incomplete: ${incompleteReason}`);
  }
};

export const readStructuredOutputText = (response: {
  output_text?: unknown;
  output?: unknown;
}) => {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  return readOutputText(response) ?? null;
};

export const parseStructuredOutput = <T>(
  response: {
    output_text?: unknown;
    output?: unknown;
    refusal?: unknown;
    status?: unknown;
    incomplete_details?: unknown;
  },
  textFormat: StructuredTextFormat<T>
) => {
  assertStructuredOutputReady(response);
  const text = readStructuredOutputText(response);
  if (!text) {
    throw new Error("Structured output missing payload");
  }

  return textFormat.$parseRaw(text);
};

export const buildResponsesUsage = (
  usage:
    | {
        input_tokens?: number | null;
        output_tokens?: number | null;
        total_tokens?: number | null;
      }
    | null
    | undefined,
  modelId: string
) => {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const totalTokens = usage?.total_tokens ?? inputTokens + outputTokens;

  return {
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
    } satisfies ResponseUsageSummary,
    costUsd: estimateCost(modelId, inputTokens, outputTokens),
  };
};

const toStructuredContractError = (error: unknown, fallbackMessage: string) => {
  if (
    error instanceof Error &&
    error.message.startsWith("Structured output refused:")
  ) {
    return new ResponsesRequestError(`${fallbackMessage} refused`, {
      kind: "refused",
    });
  }

  if (
    error instanceof Error &&
    error.message.startsWith("Structured output incomplete:")
  ) {
    return new ResponsesRequestError(`${fallbackMessage} incomplete`, {
      kind: "incomplete",
    });
  }

  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return new ResponsesRequestError(`${fallbackMessage} timed out`, {
      kind: "timed_out",
    });
  }

  return null;
};

const getApiErrorMetadata = (error: unknown) => {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : null;
  const nestedError =
    record?.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : null;

  let status: number | undefined;
  if (typeof record?.status === "number") {
    status = record.status;
  } else if (typeof nestedError?.status === "number") {
    status = nestedError.status;
  }

  let code: string | undefined;
  if (typeof record?.code === "string") {
    code = record.code;
  } else if (typeof nestedError?.code === "string") {
    code = nestedError.code;
  }

  let type: string | undefined;
  if (typeof record?.type === "string") {
    type = record.type;
  } else if (typeof nestedError?.type === "string") {
    type = nestedError.type;
  }

  return {
    status,
    code,
    type,
    detail: [error instanceof Error ? error.message : "", code, type]
      .filter(Boolean)
      .join(" "),
  };
};

export const handleResponsesError = (
  error: unknown,
  fallbackMessage: string
): never => {
  const structuredContractError = toStructuredContractError(
    error,
    fallbackMessage
  );
  if (structuredContractError) {
    throw structuredContractError;
  }

  const { status, code, type, detail } = getApiErrorMetadata(error);
  const isInputTooLarge =
    status === 400 && INPUT_TOO_LARGE_PATTERN.test(detail);

  if (isInputTooLarge) {
    throw new ResponsesRequestError(`${fallbackMessage} input too large`, {
      kind: "input_too_large",
      status,
      code,
      type,
    });
  }

  const isTransient =
    status === 429 || (typeof status === "number" && status >= 500);
  if (isTransient) {
    throw new ResponsesRequestError(
      `${fallbackMessage} temporarily unavailable`,
      {
        kind: "transient",
        status,
        code,
        type,
        retryable: true,
      }
    );
  }

  throw new ResponsesRequestError(fallbackMessage, {
    kind: "failed",
    status,
    code,
    type,
  });
};

export const createStructuredResponse = async <T>({
  options,
  request,
}: {
  options: ResponsesRuntimeOptions;
  request: RawResponsesRequest<T>;
}) => {
  const modelId = resolveResponsesModel(options);
  const client = createResponsesClient(options);
  const signal = createResponsesAbortSignal(
    options.timeout,
    options.abortSignal
  );
  const response = await client.responses.create(
    {
      model: modelId,
      input: [
        {
          role: "system",
          content: request.system,
        },
        {
          role: "user",
          content: request.prompt,
        },
      ],
      max_output_tokens: getResponsesMaxOutputTokens(options.maxOutputTokens),
      prompt_cache_key: options.promptCacheKey,
      reasoning: options.reasoningEffort
        ? { effort: options.reasoningEffort }
        : undefined,
      safety_identifier: options.safetyIdentifier,
      store: options.store ?? false,
      text: { format: request.textFormat },
      truncation: "disabled",
    },
    {
      signal,
    }
  );

  return {
    modelId,
    response,
    parsed: parseStructuredOutput(response, request.textFormat),
    usage: buildResponsesUsage(response.usage, modelId),
  };
};
