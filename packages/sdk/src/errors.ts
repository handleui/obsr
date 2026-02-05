/**
 * Detent SDK Error Classes
 */

/** Base error class for all Detent SDK errors */
export class DetentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetentError";
  }
}

/** Network-level errors (connection failures, timeouts) */
export class DetentNetworkError extends DetentError {
  constructor(message: string) {
    super(message);
    this.name = "DetentNetworkError";
  }
}

/** Authentication errors (401, invalid tokens) */
export class DetentAuthError extends DetentError {
  constructor(message: string) {
    super(message);
    this.name = "DetentAuthError";
  }
}

/** API errors with status codes and error messages */
export class DetentApiError extends DetentError {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "DetentApiError";
    this.status = status;
    this.code = code;
  }
}
