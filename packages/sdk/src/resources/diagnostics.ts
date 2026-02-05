/**
 * Diagnostics Resource
 *
 * CI log parsing operations.
 */

import type { DetentClient } from "../client.js";
import type {
  DetectedTool,
  DiagnosticMode,
  DiagnosticsResponse,
} from "../types.js";

export interface ParseOptions {
  /** Hint for the parser (auto-detected if not provided) */
  tool?: DetectedTool;
  /** Response detail level (defaults to "full") */
  mode?: DiagnosticMode;
}

export class DiagnosticsResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** Parse CI/build logs into structured diagnostics */
  async parse(
    content: string,
    options: ParseOptions = {}
  ): Promise<DiagnosticsResponse> {
    // Validate parameters
    if (!content || typeof content !== "string") {
      throw new Error("Content must be a non-empty string");
    }
    if (options.tool !== undefined && !["eslint", "vitest", "typescript", "cargo", "golangci"].includes(options.tool)) {
      throw new Error("Tool must be one of: eslint, vitest, typescript, cargo, golangci");
    }
    if (options.mode !== undefined && !["full", "lite"].includes(options.mode)) {
      throw new Error("Mode must be one of: full, lite");
    }

    return this.#client.request<DiagnosticsResponse>("/v1/diagnostics", {
      method: "POST",
      body: {
        content,
        tool: options.tool,
        mode: options.mode ?? "full",
      },
    });
  }
}
