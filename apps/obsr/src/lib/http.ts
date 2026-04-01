import { scrubFilePath, scrubSecrets } from "@obsr/types";
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";

export class RouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const jsonError = (status: number, code: string, message: string) => {
  return NextResponse.json(
    {
      error: {
        code,
        message,
      },
    },
    { status }
  );
};

const getJsonContentLength = (request: Request) => {
  const contentLength = request.headers.get("content-length");
  if (!contentLength) {
    return null;
  }

  const parsed = Number.parseInt(contentLength, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const isJsonRequest = (request: Request) => {
  return request.headers.get("content-type")?.includes("application/json");
};

const readRequestBody = async (request: Request, maxBytes?: number) => {
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (maxBytes && totalBytes > maxBytes) {
      throw new RouteError(
        413,
        "INPUT_TOO_LARGE",
        "Request body is too large."
      );
    }

    body += decoder.decode(value, { stream: true });
  }

  return `${body}${decoder.decode()}`;
};

export const parseJsonRequest = async <TSchema extends ZodType>(
  request: Request,
  schema: TSchema,
  maxBytes?: number
) => {
  if (!isJsonRequest(request)) {
    throw new RouteError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Request body must be JSON."
    );
  }

  const contentLength = getJsonContentLength(request);
  if (maxBytes && contentLength && contentLength > maxBytes) {
    throw new RouteError(413, "INPUT_TOO_LARGE", "Request body is too large.");
  }

  let body: unknown;
  try {
    body = JSON.parse(await readRequestBody(request, maxBytes));
  } catch (error) {
    if (error instanceof RouteError) {
      throw error;
    }

    throw new RouteError(
      400,
      "INVALID_JSON",
      "Request body must be valid JSON."
    );
  }

  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new RouteError(
        400,
        "INVALID_INPUT",
        "Request body did not match schema."
      );
    }

    throw error;
  }
};

export const isRouteNotFoundError = (error: unknown) => {
  return error instanceof RouteError && error.status === 404;
};

const toSafeErrorLog = (error: unknown) => {
  if (!(error instanceof Error)) {
    return { name: "UnknownThrownValue" };
  }

  return {
    name: error.name,
    message:
      scrubFilePath(scrubSecrets(error.message))?.slice(0, 300) ??
      "Unknown error.",
  };
};

export const handleRouteError = (error: unknown) => {
  if (error instanceof RouteError) {
    return jsonError(error.status, error.code, error.message);
  }

  if (error instanceof ZodError) {
    console.error("[obsr-schema]", {
      issues: error.issues.length,
      ...toSafeErrorLog(error),
    });
    return jsonError(500, "INTERNAL_ERROR", "Unexpected server error.");
  }

  console.error("[obsr-route]", toSafeErrorLog(error));
  return jsonError(500, "INTERNAL_ERROR", "Unexpected server error.");
};
