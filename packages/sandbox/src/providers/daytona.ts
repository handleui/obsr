import {
  type CreateSandboxFromSnapshotParams,
  Daytona,
  type DaytonaConfig,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  type Sandbox as DaytonaSandbox,
} from "@daytonaio/sdk";
import type {
  SandboxCodeExecution,
  SandboxCommandExecution,
  SandboxHandle,
  SandboxInfo,
  SandboxOptions,
  SandboxProvider,
} from "../types.js";

interface DaytonaProviderOptions {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
  organizationId?: string;
  jwtToken?: string;
}

const IDEMPOTENCY_LABEL_PREFIX = "detent";
const IDEMPOTENCY_LABEL_KEY = `${IDEMPOTENCY_LABEL_PREFIX}.resolve.id`;
const PROVIDER_LABEL_KEY = `${IDEMPOTENCY_LABEL_PREFIX}.provider`;
const PROVIDER_LABEL_VALUE = "daytona";
const DEFAULT_AUTO_STOP_MINUTES = 10;

const toDaytonaLanguage = (template?: string): string => {
  if (!template) {
    return "python";
  }
  return template.includes("node") ? "javascript" : "python";
};

const normalizeTimeoutMinutes = (timeoutSec?: number): number => {
  if (!(timeoutSec && Number.isFinite(timeoutSec))) {
    return DEFAULT_AUTO_STOP_MINUTES;
  }
  return Math.max(1, Math.ceil(timeoutSec / 60));
};

const isRunningState = (state?: string | null): boolean =>
  ["started", "running"].includes(String(state ?? "").toLowerCase());

interface SandboxInfoSource {
  id: string;
  snapshot?: string;
  labels?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

const toSandboxInfo = (sandbox: SandboxInfoSource): SandboxInfo => {
  let startedAt: Date | undefined;
  if (sandbox.createdAt) {
    startedAt = new Date(sandbox.createdAt);
  } else if (sandbox.updatedAt) {
    startedAt = new Date(sandbox.updatedAt);
  }

  return {
    sandboxId: sandbox.id,
    template: sandbox.snapshot ?? "unknown",
    metadata: sandbox.labels ?? {},
    startedAt,
  };
};

const toMetadataLabels = (
  metadata?: Record<string, string>
): Record<string, string> => {
  const labels: Record<string, string> = {
    [PROVIDER_LABEL_KEY]: PROVIDER_LABEL_VALUE,
  };
  if (!metadata) {
    return labels;
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (!(key && value)) {
      continue;
    }
    labels[`${IDEMPOTENCY_LABEL_PREFIX}.meta.${key}`] = value;
  }

  return labels;
};

class DaytonaSandboxHandle implements SandboxHandle {
  readonly #sandbox: DaytonaSandbox;
  readonly #daytona: Daytona;

  constructor(sandbox: DaytonaSandbox, daytona: Daytona) {
    this.#sandbox = sandbox;
    this.#daytona = daytona;
  }

  get sandboxId(): string {
    return this.#sandbox.id;
  }

  runCode = async (
    code: string,
    opts?: {
      language?: string;
      timeoutMs?: number;
      envs?: Record<string, string>;
    }
  ): Promise<SandboxCodeExecution> => {
    const timeout = opts?.timeoutMs
      ? Math.ceil(opts.timeoutMs / 1000)
      : undefined;

    if (opts?.language === "bash") {
      const result = await this.#sandbox.process.executeCommand(
        code,
        undefined,
        opts?.envs,
        timeout
      );
      return {
        logs: {
          stdout: [result.result ?? ""],
          stderr: [],
        },
        text: result.result,
        error: result.exitCode === 0 ? undefined : { value: result.result },
      };
    }

    if (opts?.language === "ts") {
      const command = `node -e ${JSON.stringify(code)}`;
      const result = await this.#sandbox.process.executeCommand(
        command,
        undefined,
        opts?.envs,
        timeout
      );
      return {
        logs: {
          stdout: [result.result ?? ""],
          stderr: [],
        },
        text: result.result,
        error: result.exitCode === 0 ? undefined : { value: result.result },
      };
    }

    const result = await this.#sandbox.process.codeRun(
      code,
      {
        env: opts?.envs,
      },
      timeout
    );

    return {
      logs: {
        stdout: [result.result ?? ""],
        stderr: [],
      },
      text: result.result,
      error: result.exitCode === 0 ? undefined : { value: result.result },
    };
  };

  commands = {
    run: async (
      command: string,
      opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number }
    ): Promise<SandboxCommandExecution> => {
      const timeout = opts?.timeoutMs
        ? Math.ceil(opts.timeoutMs / 1000)
        : undefined;
      const response = await this.#sandbox.process.executeCommand(
        command,
        opts?.cwd,
        opts?.envs,
        timeout
      );

      return {
        stdout: response.result ?? "",
        stderr: "",
        exitCode: response.exitCode ?? 0,
      };
    },
  };

  files = {
    write: async (path: string, content: string) => {
      await this.#sandbox.fs.uploadFile(Buffer.from(content), path);
    },
    read: async (
      path: string,
      opts?: { format?: "text" | "binary" }
    ): Promise<string | Uint8Array> => {
      const buffer = await this.#sandbox.fs.downloadFile(path);
      if (opts?.format === "binary") {
        return new Uint8Array(buffer);
      }
      return new TextDecoder().decode(buffer);
    },
    exists: async (path: string): Promise<boolean> => {
      try {
        await this.#sandbox.fs.getFileDetails(path);
        return true;
      } catch {
        return false;
      }
    },
    getInfo: async (path: string) => {
      try {
        const info = await this.#sandbox.fs.getFileDetails(path);
        const isDir =
          String((info as { type?: unknown }).type).toLowerCase() === "dir";
        return { type: isDir ? ("dir" as const) : ("file" as const) };
      } catch {
        throw new Error("File not found");
      }
    },
  };

  kill = async () => {
    await this.#daytona.stop(this.#sandbox);
  };

  setTimeout = async (timeoutMs: number) => {
    const minutes = normalizeTimeoutMinutes(timeoutMs / 1000);
    await this.#sandbox.setAutoDeleteInterval(-1);
    await this.#sandbox.setAutostopInterval(minutes);
  };

  isRunning = async (): Promise<boolean> => {
    try {
      await this.#sandbox.refreshData();
    } catch {
      return false;
    }

    return isRunningState(this.#sandbox.state as string | undefined);
  };
}

const extractResolveId = (
  metadata?: Record<string, string> | undefined
): string | undefined => {
  const value = metadata?.resolveId?.trim();
  return value === "" ? undefined : value;
};

const shouldReuseSandbox = (
  metadata?: Record<string, string> | undefined
): boolean => extractResolveId(metadata) !== undefined;

const getIdentityLabels = (
  metadata?: Record<string, string> | undefined
): Record<string, string> | undefined => {
  const resolveId = extractResolveId(metadata);
  if (!resolveId) {
    return undefined;
  }

  return {
    ...toMetadataLabels(metadata),
    [IDEMPOTENCY_LABEL_KEY]: resolveId,
  };
};

export const createDaytonaProvider = (
  options: DaytonaProviderOptions
): SandboxProvider => {
  const config: DaytonaConfig = {
    apiKey: options.apiKey,
    apiUrl: options.apiUrl,
    target: options.target,
    organizationId: options.organizationId,
    jwtToken: options.jwtToken,
  };
  const daytona = new Daytona(config);

  const toCreateParams = (
    opts?: SandboxOptions
  ): CreateSandboxFromSnapshotParams => {
    const language = toDaytonaLanguage(opts?.template);
    const labels = toMetadataLabels(opts?.metadata);
    const resolveId = extractResolveId(opts?.metadata);

    if (resolveId) {
      labels[IDEMPOTENCY_LABEL_KEY] = resolveId;
    }

    return {
      language,
      envVars: opts?.envs,
      labels,
      autoStopInterval: normalizeTimeoutMinutes(opts?.timeout),
      autoDeleteInterval: -1,
    };
  };

  const resolveExisting = async (
    metadata?: Record<string, string> | undefined
  ): Promise<DaytonaSandbox | null> => {
    const labels = getIdentityLabels(metadata);
    if (!labels) {
      return null;
    }

    try {
      return await daytona.findOne({ labels });
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) {
        return null;
      }
      throw error;
    }
  };

  const normalize = async (
    sandbox: DaytonaSandbox
  ): Promise<DaytonaSandbox> => {
    if (!isRunningState(sandbox.state)) {
      await daytona.start(sandbox);
      await sandbox.refreshData();
    }
    return sandbox;
  };

  const list = async () => {
    const { items } = await daytona.list({
      [PROVIDER_LABEL_KEY]: PROVIDER_LABEL_VALUE,
    });
    return items.map(toSandboxInfo);
  };

  return {
    name: "daytona",
    create: async (opts?: SandboxOptions) => {
      const existing = shouldReuseSandbox(opts?.metadata)
        ? await resolveExisting(opts?.metadata)
        : null;

      if (existing) {
        const ready = await normalize(existing);
        return new DaytonaSandboxHandle(ready, daytona);
      }

      const sandbox = await daytona.create(toCreateParams(opts));
      return new DaytonaSandboxHandle(sandbox, daytona);
    },
    connect: async (sandboxId: string) => {
      const sandbox = await daytona.get(sandboxId);
      return new DaytonaSandboxHandle(sandbox, daytona);
    },
    list,
    isRateLimitError: (error: unknown) =>
      error instanceof DaytonaRateLimitError,
  };
};
