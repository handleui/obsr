import { RateLimitError, Sandbox } from "@e2b/code-interpreter";
import type {
  SandboxCommandExecution,
  SandboxHandle,
  SandboxInfo,
  SandboxOptions,
  SandboxProvider,
} from "../types.js";

interface E2BProviderOptions {
  apiKey: string;
}

class E2BSandboxHandle implements SandboxHandle {
  readonly #sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this.#sandbox = sandbox;
  }

  get sandboxId(): string {
    return this.#sandbox.sandboxId;
  }

  runCode = async (
    code: string,
    opts?: { language?: string; timeoutMs?: number }
  ) => this.#sandbox.runCode(code, opts);

  commands = {
    run: async (
      command: string,
      opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number }
    ): Promise<SandboxCommandExecution> =>
      this.#sandbox.commands.run(command, opts),
  };

  files = {
    write: async (path: string, content: string) => {
      await this.#sandbox.files.write(path, content);
    },
    read: async (path: string, opts?: { format?: "text" | "binary" }) => {
      const reader = this.#sandbox.files.read as (
        filePath: string,
        readOpts?: unknown
      ) => Promise<unknown>;
      const content = await reader(path, opts);
      return content as string | Uint8Array;
    },
    exists: async (path: string) => this.#sandbox.files.exists(path),
    getInfo: async (path: string) => {
      const info = await this.#sandbox.files.getInfo(path);
      return { type: info.type === "dir" ? "dir" : "file" } as const;
    },
  };

  kill = async () => this.#sandbox.kill();

  setTimeout = async (timeoutMs: number) => this.#sandbox.setTimeout(timeoutMs);

  isRunning = async () => this.#sandbox.isRunning();
}

const toSandboxInfo = (sandbox: Sandbox): SandboxInfo => {
  const meta = sandbox as Sandbox & {
    templateId?: string | null;
    metadata?: Record<string, string> | null;
    startedAt?: string | number | Date | null;
  };
  return {
    sandboxId: sandbox.sandboxId,
    template: meta.templateId ?? "unknown",
    metadata: meta.metadata ?? {},
    startedAt: meta.startedAt ? new Date(meta.startedAt) : undefined,
  };
};

const listSandboxes = async (apiKey: string): Promise<SandboxInfo[]> => {
  const response = await Sandbox.list({
    apiKey,
    query: { state: ["running"] },
  });

  if (Array.isArray(response)) {
    return response.map(toSandboxInfo);
  }

  if (response && typeof response === "object" && "hasNext" in response) {
    const paginator = response as unknown as {
      hasNext: boolean;
      nextItems: () => Promise<Sandbox[]>;
    };
    const results: SandboxInfo[] = [];
    while (paginator.hasNext) {
      const items = await paginator.nextItems();
      results.push(...items.map(toSandboxInfo));
    }
    return results;
  }

  return [];
};

export const createE2BProvider = (
  options: E2BProviderOptions
): SandboxProvider => ({
  name: "e2b",
  create: async (opts?: SandboxOptions) => {
    const sandbox = await Sandbox.create(opts?.template ?? "base", {
      apiKey: options.apiKey,
      timeoutMs: opts?.timeout ? opts.timeout * 1000 : undefined,
      metadata: opts?.metadata,
      envs: opts?.envs,
    });
    return new E2BSandboxHandle(sandbox);
  },
  connect: async (sandboxId: string) => {
    const sandbox = await Sandbox.connect(sandboxId, {
      apiKey: options.apiKey,
    });
    return new E2BSandboxHandle(sandbox);
  },
  list: async () => listSandboxes(options.apiKey),
  isRateLimitError: (error: unknown) => error instanceof RateLimitError,
});
