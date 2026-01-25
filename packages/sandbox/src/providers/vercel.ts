import { Sandbox } from "@vercel/sandbox";
import { DEFAULT_TEMPLATE, TEMPLATES } from "../config.js";
import type {
  SandboxCodeExecution,
  SandboxCommandExecution,
  SandboxHandle,
  SandboxInfo,
  SandboxOptions,
  SandboxProvider,
} from "../types.js";

interface VercelAuthOptions {
  token?: string;
  teamId?: string;
  projectId?: string;
}

interface VercelSandboxSummary {
  id?: string;
  sandboxId?: string;
  runtime?: string;
  createdAt?: string | number | Date;
  requestedAt?: number;
}

const DEFAULT_ROOT = "/vercel/sandbox";
const LEGACY_ROOT = "/home/user";

const normalizePath = (path: string): string => {
  if (path.startsWith(LEGACY_ROOT)) {
    return `${DEFAULT_ROOT}${path.slice(LEGACY_ROOT.length)}`;
  }
  return path;
};

const getRuntimeForTemplate = (template?: string): string => {
  const resolved = template ?? DEFAULT_TEMPLATE;
  switch (resolved) {
    case TEMPLATES.PYTHON:
      return "python3.13";
    case TEMPLATES.NODE:
      return "node22";
    default:
      return "node22";
  }
};

const createAbortSignal = (timeoutMs?: number) => {
  if (!timeoutMs) {
    return { signal: undefined, clear: () => undefined };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
};

const renderShellCommand = (
  command: string
): { cmd: string; args: string[] } => ({
  cmd: "bash",
  args: ["-lc", command],
});

const escapeShellPath = (path: string): string =>
  `'${path.replace(/'/g, "'\\''")}'`;

const toSandboxInfo = (summary: VercelSandboxSummary): SandboxInfo => {
  let startedAt: Date | undefined;
  if (summary.createdAt) {
    startedAt = new Date(summary.createdAt);
  } else if (summary.requestedAt) {
    startedAt = new Date(summary.requestedAt);
  }

  return {
    sandboxId: summary.sandboxId ?? summary.id ?? "unknown",
    template: summary.runtime ?? "unknown",
    metadata: {},
    startedAt,
  };
};

const isVercelRateLimitError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  if (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("429")
  ) {
    return true;
  }
  const status = (error as { status?: number; statusCode?: number }).status;
  const statusCode = (error as { status?: number; statusCode?: number })
    .statusCode;
  return status === 429 || statusCode === 429;
};

class VercelSandboxHandle implements SandboxHandle {
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
  ): Promise<SandboxCodeExecution> => {
    const language = opts?.language ?? "python";
    const { signal, clear } = createAbortSignal(opts?.timeoutMs);

    try {
      let command = "";
      if (language === "bash") {
        command = code;
      } else if (language === "ts") {
        command = `node -e ${JSON.stringify(code)}`;
      } else {
        const markerBase = "PYCODE";
        let marker = markerBase;
        while (code.includes(marker)) {
          marker = `${marker}_END`;
        }
        command = `python3 - <<'${marker}'\n${code}\n${marker}`;
      }

      const { cmd, args } = renderShellCommand(command);
      try {
        const result = await this.#sandbox.runCommand({
          cmd,
          args,
          signal,
        });
        const stdout = await result.stdout();
        const stderr = await result.stderr();

        return {
          logs: {
            stdout: stdout ? [stdout] : [],
            stderr: stderr ? [stderr] : [],
          },
          text: undefined,
          error:
            result.exitCode === 0 ? undefined : { value: stderr || stdout },
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Code execution timed out");
        }
        throw error;
      }
    } finally {
      clear();
    }
  };

  commands = {
    run: async (
      command: string,
      opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number }
    ): Promise<SandboxCommandExecution> => {
      const { signal, clear } = createAbortSignal(opts?.timeoutMs);
      const cwd = opts?.cwd ? normalizePath(opts.cwd) : undefined;
      const { cmd, args } = renderShellCommand(command);

      try {
        try {
          const result = await this.#sandbox.runCommand({
            cmd,
            args,
            cwd,
            env: opts?.envs,
            signal,
          });

          return {
            stdout: await result.stdout(),
            stderr: await result.stderr(),
            exitCode: result.exitCode ?? 0,
          };
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            throw new Error("Command execution timed out");
          }
          throw error;
        }
      } finally {
        clear();
      }
    },
  };

  files = {
    write: async (path: string, content: string) => {
      const resolvedPath = normalizePath(path);
      await this.#sandbox.writeFiles([
        { path: resolvedPath, content: Buffer.from(content) },
      ]);
    },
    read: async (path: string, opts?: { format?: "text" | "binary" }) => {
      const resolvedPath = normalizePath(path);
      const sandbox = this.#sandbox as Sandbox & {
        readFileToBuffer?: (opts: { path: string }) => Promise<Buffer | null>;
        readFile?: (opts: { path: string }) => Promise<ReadableStream | null>;
      };
      let buffer: Buffer;
      if (sandbox.readFileToBuffer) {
        const readBuffer = await sandbox.readFileToBuffer({
          path: resolvedPath,
        });
        if (!readBuffer) {
          throw new Error("file not found");
        }
        buffer = readBuffer;
      } else {
        const stream = await sandbox.readFile?.({ path: resolvedPath });
        if (!stream) {
          throw new Error("file not found");
        }
        const arrayBuffer = await new Response(
          stream as unknown as BodyInit
        ).arrayBuffer();
        buffer = Buffer.from(arrayBuffer);
      }
      if (opts?.format === "text") {
        return new TextDecoder().decode(buffer);
      }
      return buffer;
    },
    exists: async (path: string) => {
      const resolvedPath = normalizePath(path);
      const escaped = escapeShellPath(resolvedPath);
      const { cmd, args } = renderShellCommand(`test -e ${escaped}`);
      const result = await this.#sandbox.runCommand({ cmd, args });
      return result.exitCode === 0;
    },
    getInfo: async (path: string) => {
      const resolvedPath = normalizePath(path);
      const escaped = escapeShellPath(resolvedPath);
      const { cmd, args } = renderShellCommand(`test -d ${escaped}`);
      const dirResult = await this.#sandbox.runCommand({ cmd, args });
      if (dirResult.exitCode === 0) {
        return { type: "dir" as const };
      }
      return { type: "file" as const };
    },
  };

  kill = async () => {
    await this.#sandbox.stop();
  };

  setTimeout = async (timeoutMs: number) => {
    await this.#sandbox.extendTimeout(timeoutMs);
  };

  isRunning = async () => {
    try {
      const status = this.#sandbox.status;
      return await Promise.resolve(
        status === "running" || status === "pending"
      );
    } catch {
      return await Promise.resolve(true);
    }
  };
}

export const createVercelProvider = (
  auth: VercelAuthOptions
): SandboxProvider => ({
  name: "vercel",
  create: async (opts?: SandboxOptions) => {
    const runtime = getRuntimeForTemplate(opts?.template);
    const sandbox = await Sandbox.create({
      runtime,
      timeout: opts?.timeout ? opts.timeout * 1000 : undefined,
      token: auth.token,
      teamId: auth.teamId,
      projectId: auth.projectId,
    });
    return new VercelSandboxHandle(sandbox);
  },
  connect: async (sandboxId: string) => {
    const sandbox = await Sandbox.get({
      sandboxId,
      token: auth.token,
      teamId: auth.teamId,
      projectId: auth.projectId,
    });
    return new VercelSandboxHandle(sandbox);
  },
  list: async () => {
    if (!auth.projectId) {
      throw new Error("projectId is required to list sandboxes");
    }
    const response = await Sandbox.list({
      projectId: auth.projectId,
      token: auth.token,
      teamId: auth.teamId,
    });
    const sandboxes = response?.json?.sandboxes ?? [];
    return sandboxes.map(toSandboxInfo);
  },
  isRateLimitError: isVercelRateLimitError,
});
