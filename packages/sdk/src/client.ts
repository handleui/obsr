import { DetentApiError, DetentAuthError, DetentNetworkError } from "./errors.js";
import { AuthResource } from "./resources/auth.js";
import { ErrorsResource } from "./resources/errors.js";
import { HealsResource } from "./resources/heals.js";
import { InvitationsResource } from "./resources/invitations.js";
import { MembersResource } from "./resources/members.js";
import { OrganizationsResource } from "./resources/organizations.js";
import { ProjectsResource } from "./resources/projects.js";
import type { AuthConfig, DetentConfig } from "./types.js";
import { sanitizeCredentials } from "./utils/sanitize.js";

const DEFAULT_BASE_URL = "https://backend.detent.sh";
const DEFAULT_TIMEOUT = 30_000;

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

  readonly auth: AuthResource;
  readonly projects: ProjectsResource;
  readonly errors: ErrorsResource;
  readonly heals: HealsResource;
  readonly organizations: OrganizationsResource;
  readonly members: MembersResource;
  readonly invitations: InvitationsResource;

  constructor(config: DetentConfig) {
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    validateBaseUrl(baseUrl);
    validateAuth(config.auth);
    this.#baseUrl = baseUrl;
    this.#auth = config.auth;
    this.#timeout = config.timeout ?? DEFAULT_TIMEOUT;

    this.#baseHeaders = { "Content-Type": "application/json" };
    if (this.#auth.type === "jwt") {
      this.#baseHeaders["Authorization"] = `Bearer ${this.#auth.token}`;
    } else {
      this.#baseHeaders["X-Detent-Token"] = this.#auth.token;
    }

    this.auth = new AuthResource(this);
    this.projects = new ProjectsResource(this);
    this.errors = new ErrorsResource(this);
    this.heals = new HealsResource(this);
    this.organizations = new OrganizationsResource(this);
    this.members = new MembersResource(this);
    this.invitations = new InvitationsResource(this);
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", body, headers: extraHeaders } = options;

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
      throw this.#wrapFetchError(error);
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      await this.#throwApiError(response);
    }

    return response.json() as Promise<T>;
  }

  #wrapFetchError(error: unknown): Error {
    if (error instanceof DOMException && error.name === "AbortError") {
      return new DetentNetworkError(
        `Request timed out after ${this.#timeout}ms`
      );
    }

    if (error instanceof TypeError && error.message.includes("fetch")) {
      return new DetentNetworkError(
        "Network error: Unable to connect to the Detent API. Please check your internet connection."
      );
    }

    if (error instanceof Error) {
      const sanitized = new Error(sanitizeCredentials(error.message));
      sanitized.name = error.name;
      return sanitized;
    }

    return error instanceof Error ? error : new Error(String(error));
  }

  async #throwApiError(response: Response): Promise<never> {
    if (response.status === 401) {
      throw new DetentAuthError(
        "Authentication failed. Your session may have expired."
      );
    }

    const errorData = (await response
      .json()
      .catch(() => ({}))) as ApiErrorResponse;

    const errorMessage = sanitizeCredentials(
      errorData.error ?? `API request failed: ${response.status}`
    );

    throw new DetentApiError(errorMessage, response.status);
  }
}

export const createClient = (config: DetentConfig): DetentClient =>
  new DetentClient(config);
