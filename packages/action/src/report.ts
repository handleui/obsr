// biome-ignore lint/performance/noNamespaceImport: GitHub Actions SDK official pattern
import * as core from "@actions/core";

import type { ReportPayload } from "./collect";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 10_000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const calculateBackoff = (attempt: number): number => {
  const exponential = BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * 1000;
  return Math.min(exponential + jitter, MAX_DELAY_MS);
};

const isTransientError = (status: number): boolean => status >= 500;

const isClientError = (status: number): boolean =>
  status >= 400 && status < 500;

const isNetworkError = (error: unknown): boolean => {
  // Fetch throws TypeError for network failures
  if (error instanceof TypeError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const networkIndicators = [
    "network",
    "fetch",
    "econnrefused",
    "econnreset",
    "etimedout",
  ];
  return networkIndicators.some((indicator) => message.includes(indicator));
};

const logRetry = (reason: string, attempt: number, backoffMs: number): void => {
  core.warning(
    `${reason}, retrying in ${Math.round(backoffMs)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
  );
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const makeRequest = async (
  apiUrl: string,
  payload: ReportPayload,
  token: string
): Promise<Response> =>
  fetch(`${apiUrl}/report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Detent-Token": token,
    },
    body: JSON.stringify(payload),
  });

const handleResponse = async (
  response: Response,
  attempt: number
): Promise<{ stored: number; runId: string } | "retry" | Error> => {
  if (response.ok) {
    return response.json() as Promise<{ stored: number; runId: string }>;
  }

  const errorText = await response.text();
  const error = new Error(`Failed to report: ${response.status} ${errorText}`);

  if (isClientError(response.status)) {
    return error;
  }

  if (isTransientError(response.status) && attempt < MAX_RETRIES) {
    const backoffMs = calculateBackoff(attempt);
    logRetry(`Request failed with ${response.status}`, attempt, backoffMs);
    await delay(backoffMs);
    return "retry";
  }

  return error;
};

const handleNetworkError = async (
  error: unknown,
  attempt: number
): Promise<"retry" | Error> => {
  if (isNetworkError(error) && attempt < MAX_RETRIES) {
    const backoffMs = calculateBackoff(attempt);
    logRetry(`Network error: ${toError(error).message}`, attempt, backoffMs);
    await delay(backoffMs);
    return "retry";
  }
  return toError(error);
};

export const report = async (
  payload: ReportPayload,
  token: string,
  apiUrl: string
): Promise<{ stored: number; runId: string }> => {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await makeRequest(apiUrl, payload, token);
      const result = await handleResponse(response, attempt);

      if (result === "retry") {
        lastError = new Error(`Failed with status ${response.status}`);
        continue;
      }
      if (result instanceof Error) {
        throw result;
      }
      return result;
    } catch (error) {
      const result = await handleNetworkError(error, attempt);
      if (result === "retry") {
        lastError = toError(error);
        continue;
      }
      throw result;
    }
  }

  throw lastError ?? new Error("Failed to report after retries");
};
