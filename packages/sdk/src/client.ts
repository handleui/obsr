/**
 * Detent SDK Client
 *
 * Main client class for interacting with the Detent API.
 */

import { DetentApiError, DetentAuthError, DetentNetworkError } from "./errors.js";
import { AuthResource } from "./resources/auth.js";
import { DiagnosticsResource } from "./resources/diagnostics.js";
import { ErrorsResource } from "./resources/errors.js";
import { HealsResource } from "./resources/heals.js";
import { InvitationsResource } from "./resources/invitations.js";
import { MembersResource } from "./resources/members.js";
import { OrganizationsResource } from "./resources/organizations.js";
import { ProjectsResource } from "./resources/projects.js";
import type { AuthConfig, DetentConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://backend.detent.sh";
const DEFAULT_TIMEOUT = 30_000;

/** Validate URL is HTTPS (except localhost for development) */
const validateBaseUrl = (url: string): void => {
  try {
    const parsed = new URL(url);
    const isLocalhost =
      parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !isLocalhost) {
      throw new Error(
        "Base URL must use HTTPS protocol for security (localhost excepted)"
      );
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid base URL: ${url}`);
    }
    throw error;
  }
};

/** Validate auth configuration */
const validateAuth = (auth: AuthConfig): void => {
  if (!auth.token || typeof auth.token !== "string" || auth.token.trim() === "") {
    throw new Error("Auth token is required and must be a non-empty string");
  }
  if (auth.type === "apiKey" && !auth.token.startsWith("dtk_")) {
    throw new Error("API key must start with 'dtk_' prefix");
  }
};

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
}

interface ApiErrorResponse {
  error?: string;
}

export class DetentClient {
  readonly #baseUrl: string;
  readonly #auth: AuthConfig;
  readonly #timeout: number;
  readonly #baseHeaders: Record<string, string>;

  /** Authentication operations */
  readonly auth: AuthResource;
  /** Project operations */
  readonly projects: ProjectsResource;
  /** CI error retrieval */
  readonly errors: ErrorsResource;
  /** Diagnostics parsing */
  readonly diagnostics: DiagnosticsResource;
  /** Heal operations */
  readonly heals: HealsResource;
  /** Organization operations */
  readonly organizations: OrganizationsResource;
  /** Organization member operations */
  readonly members: MembersResource;
  /** Invitation operations */
  readonly invitations: InvitationsResource;

  constructor(config: DetentConfig) {
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    validateBaseUrl(baseUrl);
    validateAuth(config.auth);
    this.#baseUrl = baseUrl;
    this.#auth = config.auth;
    this.#timeout = config.timeout ?? DEFAULT_TIMEOUT;

    // Pre-build base headers to avoid object creation on each request
    this.#baseHeaders = { "Content-Type": "application/json" };
    if (this.#auth.type === "jwt") {
      this.#baseHeaders["Authorization"] = `Bearer ${this.#auth.token}`;
    } else {
      this.#baseHeaders["X-Detent-Token"] = this.#auth.token;
    }

    // Initialize resources
    this.auth = new AuthResource(this);
    this.projects = new ProjectsResource(this);
    this.errors = new ErrorsResource(this);
    this.diagnostics = new DiagnosticsResource(this);
    this.heals = new HealsResource(this);
    this.organizations = new OrganizationsResource(this);
    this.members = new MembersResource(this);
    this.invitations = new InvitationsResource(this);
  }

  /** Internal method for making API requests */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", body, headers: extraHeaders } = options;

    // Merge base headers with extra headers to avoid recreating on each request
    const headers =
      extraHeaders && Object.keys(extraHeaders).length > 0
        ? { ...this.#baseHeaders, ...extraHeaders }
        : this.#baseHeaders;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.#timeout);

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof DOMException && error.name === "AbortError") {
        throw new DetentNetworkError(
          `Request timed out after ${this.#timeout}ms`
        );
      }

      if (error instanceof TypeError && error.message.includes("fetch")) {
        throw new DetentNetworkError(
          "Network error: Unable to connect to the Detent API. Please check your internet connection."
        );
      }

      // Sanitize error messages that might contain sensitive data
      if (error instanceof Error) {
        const sanitizedMessage = error.message
          .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
          .replace(/dtk_[^\s"']+/gi, "[REDACTED_KEY]")
          .replace(/token[=:]\s*[^\s"']+/gi, "token=[REDACTED]");
        const sanitizedError = new Error(sanitizedMessage);
        sanitizedError.name = error.name;
        throw sanitizedError;
      }

      throw error;
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 401) {
        throw new DetentAuthError(
          "Authentication failed. Your session may have expired."
        );
      }

      const errorData = (await response
        .json()
        .catch(() => ({}))) as ApiErrorResponse;

      // Sanitize error messages to prevent leaking sensitive data
      let errorMessage = errorData.error ?? `API request failed: ${response.status}`;
      errorMessage = errorMessage
        .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
        .replace(/dtk_[^\s"']+/gi, "[REDACTED_KEY]")
        .replace(/token[=:]\s*[^\s"']+/gi, "token=[REDACTED]")
        .replace(/"?access_token"?\s*[:=]\s*[^\s,}]+/gi, "access_token=[REDACTED]")
        .replace(/"?refresh_token"?\s*[:=]\s*[^\s,}]+/gi, "refresh_token=[REDACTED]")
        .replace(/"?jwt"?\s*[:=]\s*[^\s,}]+/gi, "jwt=[REDACTED]");

      throw new DetentApiError(
        errorMessage,
        response.status
      );
    }

    return response.json() as Promise<T>;
  }
}

/** Create a new Detent client instance */
export const createClient = (config: DetentConfig): DetentClient => {
  return new DetentClient(config);
};
