import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const DANGEROUS_PATH_PATTERNS = ["..", "/", "\0", "\\"];

const containsDangerousPattern = (file: string): boolean =>
  DANGEROUS_PATH_PATTERNS.some(
    (pattern) => file.includes(pattern) || file.startsWith(pattern)
  );

const isWithinBase = (path: string, base: string): boolean =>
  path.startsWith(`${base}/`) || path === base;

const isSymlinkEscapingBase = (
  resolvedPath: string,
  resolvedBase: string
): boolean => {
  if (!existsSync(resolvedPath)) {
    return false;
  }

  try {
    const stat = lstatSync(resolvedPath);
    if (!stat.isSymbolicLink()) {
      return false;
    }

    const realPath = realpathSync(resolvedPath);
    return !isWithinBase(realPath, resolvedBase);
  } catch {
    return true;
  }
};

const safeJoin = (base: string, file: string): string | null => {
  const normalizedFile = file.normalize("NFC");
  if (containsDangerousPattern(normalizedFile)) {
    return null;
  }

  const resolvedBase = resolve(base);
  const resolvedPath = resolve(resolvedBase, normalizedFile);

  if (!isWithinBase(resolvedPath, resolvedBase)) {
    return null;
  }
  if (isSymlinkEscapingBase(resolvedPath, resolvedBase)) {
    return null;
  }

  return resolvedPath;
};

export interface AutofixConfig {
  source: string;
  command: string;
  priority: number;
}

interface ToolConfig {
  source: string;
  command: string;
  priority: number;
  detectFiles: string[];
  detectPackageJson?: string;
}

export const COMMAND_ALLOWLIST = [
  "biome check --write .",
  "eslint --fix .",
  "prettier --write .",
  "cargo clippy --fix --allow-dirty --allow-staged",
  "golangci-lint run --fix",
  "bun run fix",
  "npm run fix",
] as const;

const TOOL_REGISTRY: Record<string, ToolConfig> = {
  biome: {
    source: "biome",
    command: "biome check --write .",
    priority: 100,
    detectFiles: ["biome.json", "biome.jsonc"],
    detectPackageJson: "@biomejs/biome",
  },
  eslint: {
    source: "eslint",
    command: "eslint --fix .",
    priority: 90,
    detectFiles: [
      ".eslintrc",
      ".eslintrc.js",
      ".eslintrc.json",
      ".eslintrc.yml",
      "eslint.config.js",
      "eslint.config.mjs",
    ],
    detectPackageJson: "eslint",
  },
  prettier: {
    source: "prettier",
    command: "prettier --write .",
    priority: 80,
    detectFiles: [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.js",
      "prettier.config.js",
    ],
    detectPackageJson: "prettier",
  },
  cargo: {
    source: "cargo",
    command: "cargo clippy --fix --allow-dirty --allow-staged",
    priority: 70,
    detectFiles: ["Cargo.toml"],
  },
  golangci: {
    source: "golangci",
    command: "golangci-lint run --fix",
    priority: 70,
    detectFiles: [".golangci.yml", ".golangci.yaml", ".golangci.toml"],
  },
  "bun-fix": {
    source: "bun-fix",
    command: "bun run fix",
    priority: 60,
    detectFiles: ["bun.lockb", "bun.lock"],
  },
  "npm-fix": {
    source: "npm-fix",
    command: "npm run fix",
    priority: 50,
    detectFiles: ["package-lock.json"],
  },
  // Detection-only: used to identify TypeScript projects without running a command
  typescript: {
    source: "typescript",
    command: "",
    priority: 0,
    detectFiles: ["tsconfig.json"],
    detectPackageJson: "typescript",
  },
};

const readPackageJson = (cwd: string): Record<string, unknown> | null => {
  const packageJsonPath = safeJoin(cwd, "package.json");
  if (!(packageJsonPath && existsSync(packageJsonPath))) {
    return null;
  }
  try {
    const content = readFileSync(packageJsonPath, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const hasPackageJsonDependency = (
  packageJson: Record<string, unknown>,
  dependency: string
): boolean => {
  const devDeps = packageJson.devDependencies as
    | Record<string, string>
    | undefined;
  const deps = packageJson.dependencies as Record<string, string> | undefined;
  return Boolean(devDeps?.[dependency] || deps?.[dependency]);
};

const hasPackageJsonScript = (
  packageJson: Record<string, unknown>,
  scriptName: string
): boolean => {
  const scripts = packageJson.scripts as Record<string, string> | undefined;
  return Boolean(scripts?.[scriptName]);
};

const OTHER_PM_LOCKFILES = ["yarn.lock", "pnpm-lock.yaml"] as const;

// Build a cache of which config files exist - single pass over filesystem
const buildFileExistenceCache = (cwd: string): Set<string> => {
  const allFiles = new Set<string>();
  for (const toolConfig of Object.values(TOOL_REGISTRY)) {
    for (const file of toolConfig.detectFiles) {
      allFiles.add(file);
    }
  }
  for (const file of OTHER_PM_LOCKFILES) {
    allFiles.add(file);
  }

  const existingFiles = new Set<string>();
  for (const file of allFiles) {
    const safePath = safeJoin(cwd, file);
    if (safePath !== null && existsSync(safePath)) {
      existingFiles.add(file);
    }
  }
  return existingFiles;
};

const hasConfigFile = (
  toolConfig: ToolConfig,
  existingFiles: Set<string>
): boolean => toolConfig.detectFiles.some((file) => existingFiles.has(file));

const hasBunLock = (existingFiles: Set<string>): boolean =>
  existingFiles.has("bun.lockb") || existingFiles.has("bun.lock");

// Determines if bun-fix or npm-fix should run based on lockfiles.
// bun-fix runs if bun.lockb or bun.lock exists.
// npm-fix runs only if package-lock.json exists.
const isScriptToolConfigured = (
  source: string,
  existingFiles: Set<string>,
  packageJson: Record<string, unknown>
): boolean => {
  if (!hasPackageJsonScript(packageJson, "fix")) {
    return false;
  }
  if (source === "bun-fix") {
    return hasBunLock(existingFiles);
  }
  if (source === "npm-fix") {
    return existingFiles.has("package-lock.json");
  }
  return false;
};

const isToolConfigured = (
  toolConfig: ToolConfig,
  existingFiles: Set<string>,
  packageJson: Record<string, unknown> | null
): boolean => {
  if (hasConfigFile(toolConfig, existingFiles)) {
    return true;
  }

  if (
    packageJson &&
    toolConfig.detectPackageJson &&
    hasPackageJsonDependency(packageJson, toolConfig.detectPackageJson)
  ) {
    return true;
  }

  if (
    packageJson &&
    (toolConfig.source === "bun-fix" || toolConfig.source === "npm-fix")
  ) {
    return isScriptToolConfigured(
      toolConfig.source,
      existingFiles,
      packageJson
    );
  }

  return false;
};

export const detectConfiguredTools = (
  cwd: string = process.cwd()
): AutofixConfig[] => {
  const packageJson = readPackageJson(cwd);
  // Single filesystem pass to check all config files
  const existingFiles = buildFileExistenceCache(cwd);
  const configuredTools: AutofixConfig[] = [];

  for (const [, toolConfig] of Object.entries(TOOL_REGISTRY)) {
    if (toolConfig.command === "") {
      continue;
    }

    if (isToolConfigured(toolConfig, existingFiles, packageJson)) {
      configuredTools.push({
        source: toolConfig.source,
        command: toolConfig.command,
        priority: toolConfig.priority,
      });
    }
  }

  return configuredTools.sort((a, b) => b.priority - a.priority);
};

export const isCommandAllowed = (command: string): boolean => {
  return (COMMAND_ALLOWLIST as readonly string[]).includes(command);
};
