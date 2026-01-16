import { describe, expect, test } from "vitest";
import {
  ALLOWED_ENV_VARS,
  BLOCKED_BYTES,
  BLOCKED_COMMANDS,
  BLOCKED_ENV_SUFFIXES,
  BLOCKED_PATTERNS,
  createSafeEnv,
  extractBaseCommand,
  hasBlockedBytes,
  hasBlockedPattern,
  normalizeCommand,
  parseCommand,
  validateCommand,
} from "./execute.js";

describe("normalizeCommand", () => {
  test("collapses multiple spaces to single space", () => {
    expect(normalizeCommand("go   build")).toBe("go build");
  });

  test("collapses tabs to single space", () => {
    expect(normalizeCommand("go\tbuild")).toBe("go build");
  });

  test("collapses mixed whitespace", () => {
    expect(normalizeCommand("go \t  build")).toBe("go build");
  });

  test("preserves leading whitespace as single space", () => {
    expect(normalizeCommand("  go build")).toBe(" go build");
  });

  test("preserves trailing whitespace as single space", () => {
    expect(normalizeCommand("go build  ")).toBe("go build ");
  });

  test("handles empty string", () => {
    expect(normalizeCommand("")).toBe("");
  });

  test("handles whitespace-only string", () => {
    expect(normalizeCommand("   ")).toBe(" ");
  });

  test("preserves single spaces", () => {
    expect(normalizeCommand("go build ./...")).toBe("go build ./...");
  });

  test("handles complex command with multiple args", () => {
    expect(normalizeCommand("npm  run   test  --  --coverage")).toBe(
      "npm run test -- --coverage"
    );
  });
});

describe("extractBaseCommand", () => {
  test("extracts command from absolute path", () => {
    expect(extractBaseCommand("/usr/bin/rm")).toBe("rm");
  });

  test("extracts command from relative path", () => {
    expect(extractBaseCommand("./scripts/rm")).toBe("rm");
  });

  test("extracts command from nested path", () => {
    expect(extractBaseCommand("/usr/local/bin/node")).toBe("node");
  });

  test("returns same string for plain command", () => {
    expect(extractBaseCommand("rm")).toBe("rm");
  });

  test("handles trailing slash", () => {
    expect(extractBaseCommand("/usr/bin/")).toBe("");
  });

  test("handles empty string", () => {
    expect(extractBaseCommand("")).toBe("");
  });

  test("handles single slash", () => {
    expect(extractBaseCommand("/")).toBe("");
  });

  test("handles current directory reference", () => {
    expect(extractBaseCommand("./")).toBe("");
  });

  test("handles double slash in path", () => {
    expect(extractBaseCommand("/usr//bin/cmd")).toBe("cmd");
  });
});

describe("hasBlockedBytes", () => {
  test("detects null byte (0x00)", () => {
    expect(hasBlockedBytes("cmd\x00arg")).toBe(true);
  });

  test("detects newline (0x0a)", () => {
    expect(hasBlockedBytes("cmd\narg")).toBe(true);
  });

  test("detects carriage return (0x0d)", () => {
    expect(hasBlockedBytes("cmd\rarg")).toBe(true);
  });

  test("detects CRLF", () => {
    expect(hasBlockedBytes("cmd\r\narg")).toBe(true);
  });

  test("detects null byte at start", () => {
    expect(hasBlockedBytes("\x00cmd")).toBe(true);
  });

  test("detects null byte at end", () => {
    expect(hasBlockedBytes("cmd\x00")).toBe(true);
  });

  test("detects newline at start", () => {
    expect(hasBlockedBytes("\ncmd")).toBe(true);
  });

  test("detects newline at end", () => {
    expect(hasBlockedBytes("cmd\n")).toBe(true);
  });

  test("passes clean strings", () => {
    expect(hasBlockedBytes("go build ./...")).toBe(false);
  });

  test("passes empty string", () => {
    expect(hasBlockedBytes("")).toBe(false);
  });

  test("passes string with spaces and tabs", () => {
    expect(hasBlockedBytes("cmd arg1\targ2")).toBe(false);
  });

  test("passes unicode characters", () => {
    expect(hasBlockedBytes("echo hello world")).toBe(false);
  });

  test("verifies BLOCKED_BYTES constant contains expected values", () => {
    expect(BLOCKED_BYTES).toContain(0x00);
    expect(BLOCKED_BYTES).toContain(0x0a);
    expect(BLOCKED_BYTES).toContain(0x0d);
    expect(BLOCKED_BYTES).toHaveLength(3);
  });
});

describe("hasBlockedPattern", () => {
  describe("destructive patterns", () => {
    test("blocks rm -rf", () => {
      expect(hasBlockedPattern("rm -rf /")).toBe("rm -rf");
    });

    test("blocks rm -r", () => {
      expect(hasBlockedPattern("rm -r ./dir")).toBe("rm -r");
    });
  });

  describe("privilege escalation", () => {
    test("blocks sudo", () => {
      expect(hasBlockedPattern("sudo apt install")).toBe("sudo");
    });

    test("blocks chmod", () => {
      expect(hasBlockedPattern("chmod 777 file.sh")).toBe("chmod");
    });

    test("blocks chown", () => {
      expect(hasBlockedPattern("chown root:root file")).toBe("chown");
    });
  });

  describe("network commands", () => {
    test("blocks curl", () => {
      expect(hasBlockedPattern("curl https://example.com")).toBe("curl");
    });

    test("blocks wget", () => {
      expect(hasBlockedPattern("wget https://example.com")).toBe("wget");
    });

    test("blocks ssh", () => {
      expect(hasBlockedPattern("ssh user@host")).toBe("ssh");
    });

    test("blocks scp", () => {
      expect(hasBlockedPattern("scp file user@host:")).toBe("scp");
    });

    test("blocks nc with trailing space", () => {
      expect(hasBlockedPattern("nc localhost 8080")).toBe("nc ");
    });

    test("blocks netcat", () => {
      expect(hasBlockedPattern("netcat -l 8080")).toBe("netcat");
    });
  });

  describe("git operations", () => {
    test("blocks git push", () => {
      expect(hasBlockedPattern("git push origin main")).toBe("git push");
    });

    test("blocks git remote", () => {
      expect(hasBlockedPattern("git remote add origin")).toBe("git remote");
    });

    test("blocks git config", () => {
      expect(hasBlockedPattern("git config user.email")).toBe("git config");
    });

    test("allows git status", () => {
      expect(hasBlockedPattern("git status")).toBe(null);
    });

    test("allows git diff", () => {
      expect(hasBlockedPattern("git diff HEAD")).toBe(null);
    });
  });

  describe("shell operators", () => {
    test("blocks pipe operator", () => {
      expect(hasBlockedPattern("cat file | grep pattern")).toBe("|");
    });

    test("blocks && operator", () => {
      expect(hasBlockedPattern("cmd1 && cmd2")).toBe("&&");
    });

    test("blocks || operator (matches | first due to pattern order)", () => {
      expect(hasBlockedPattern("cmd1 || cmd2")).toBe("|");
    });

    test("blocks semicolon", () => {
      expect(hasBlockedPattern("cmd1; cmd2")).toBe(";");
    });

    test("blocks redirect to absolute path", () => {
      expect(hasBlockedPattern("echo data > /etc/passwd")).toBe("> /");
    });

    test("blocks append redirect", () => {
      expect(hasBlockedPattern("echo data >> file")).toBe(">>");
    });
  });

  describe("command substitution", () => {
    test("blocks $() substitution", () => {
      expect(hasBlockedPattern("echo $(whoami)")).toBe("$(");
    });

    test("blocks backtick substitution", () => {
      expect(hasBlockedPattern("echo `whoami`")).toBe("`");
    });

    test("blocks variable substitution with braces", () => {
      expect(hasBlockedPattern(`echo ${"${"}HOME}`)).toBe("${");
    });
  });

  describe("shell builtins", () => {
    test("blocks eval", () => {
      expect(hasBlockedPattern("eval command")).toBe("eval");
    });

    test("blocks exec", () => {
      expect(hasBlockedPattern("exec command")).toBe("exec");
    });
  });

  describe("safe commands pass", () => {
    test("allows go build", () => {
      expect(hasBlockedPattern("go build ./...")).toBe(null);
    });

    test("allows npm test", () => {
      expect(hasBlockedPattern("npm test")).toBe(null);
    });

    test("allows cargo check", () => {
      expect(hasBlockedPattern("cargo check")).toBe(null);
    });

    test("allows empty string", () => {
      expect(hasBlockedPattern("")).toBe(null);
    });
  });

  test("verifies all expected patterns are in BLOCKED_PATTERNS", () => {
    const expectedPatterns = [
      "rm -rf",
      "rm -r",
      "sudo",
      "chmod",
      "chown",
      "curl",
      "wget",
      "git push",
      "git remote",
      "git config",
      "ssh",
      "scp",
      "nc ",
      "netcat",
      "> /",
      ">>",
      "|",
      "&&",
      "||",
      ";",
      "$(",
      "`",
      "eval",
      "exec",
      "${",
    ];

    for (const pattern of expectedPatterns) {
      expect(BLOCKED_PATTERNS).toContain(pattern);
    }
    expect(BLOCKED_PATTERNS).toHaveLength(25);
  });
});

describe("createSafeEnv", () => {
  const withEnv = <T>(vars: Record<string, string>, fn: () => T): T => {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(vars)) {
      saved[key] = process.env[key];
      process.env[key] = vars[key];
    }
    try {
      return fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  };

  describe("allowed environment variables", () => {
    test("includes PATH when set", () => {
      const env = withEnv({ PATH: "/test/bin" }, createSafeEnv);
      expect(env.PATH).toBe("/test/bin");
    });

    test("includes HOME when set", () => {
      const env = withEnv({ HOME: "/test/home" }, createSafeEnv);
      expect(env.HOME).toBe("/test/home");
    });

    test("includes USER when set", () => {
      const env = withEnv({ USER: "testuser" }, createSafeEnv);
      expect(env.USER).toBe("testuser");
    });

    test("includes NODE_ENV when set", () => {
      const env = withEnv({ NODE_ENV: "test" }, createSafeEnv);
      expect(env.NODE_ENV).toBe("test");
    });

    test("includes GOPATH when set", () => {
      const env = withEnv({ GOPATH: "/home/user/go" }, createSafeEnv);
      expect(env.GOPATH).toBe("/home/user/go");
    });

    test("includes CARGO_HOME when set", () => {
      const env = withEnv({ CARGO_HOME: "/home/user/.cargo" }, createSafeEnv);
      expect(env.CARGO_HOME).toBe("/home/user/.cargo");
    });

    test("includes JAVA_HOME when set", () => {
      const env = withEnv({ JAVA_HOME: "/usr/lib/jvm/java-11" }, createSafeEnv);
      expect(env.JAVA_HOME).toBe("/usr/lib/jvm/java-11");
    });

    test("includes TMPDIR when set", () => {
      const env = withEnv({ TMPDIR: "/tmp" }, createSafeEnv);
      expect(env.TMPDIR).toBe("/tmp");
    });

    test("includes LANG when set", () => {
      const env = withEnv({ LANG: "en_US.UTF-8" }, createSafeEnv);
      expect(env.LANG).toBe("en_US.UTF-8");
    });

    test("includes SHELL when set", () => {
      const env = withEnv({ SHELL: "/bin/bash" }, createSafeEnv);
      expect(env.SHELL).toBe("/bin/bash");
    });
  });

  describe("blocked suffixes", () => {
    test("blocks _KEY suffix", () => {
      const env = withEnv({ API_KEY: "secret-key" }, createSafeEnv);
      expect(env.API_KEY).toBeUndefined();
    });

    test("blocks _TOKEN suffix", () => {
      const env = withEnv({ AUTH_TOKEN: "secret-token" }, createSafeEnv);
      expect(env.AUTH_TOKEN).toBeUndefined();
    });

    test("blocks _SECRET suffix", () => {
      const env = withEnv({ APP_SECRET: "secret-value" }, createSafeEnv);
      expect(env.APP_SECRET).toBeUndefined();
    });

    test("blocks _PASSWORD suffix", () => {
      const env = withEnv({ DB_PASSWORD: "secret-password" }, createSafeEnv);
      expect(env.DB_PASSWORD).toBeUndefined();
    });

    test("blocks _CREDS suffix", () => {
      const env = withEnv({ AWS_CREDS: "secret-creds" }, createSafeEnv);
      expect(env.AWS_CREDS).toBeUndefined();
    });

    test("blocks _AUTH suffix", () => {
      const env = withEnv({ GITHUB_AUTH: "secret-auth" }, createSafeEnv);
      expect(env.GITHUB_AUTH).toBeUndefined();
    });

    test("blocks _API suffix", () => {
      const env = withEnv({ STRIPE_API: "secret-api" }, createSafeEnv);
      expect(env.STRIPE_API).toBeUndefined();
    });

    test("blocks _APIKEY suffix", () => {
      const env = withEnv({ OPENAI_APIKEY: "secret-apikey" }, createSafeEnv);
      expect(env.OPENAI_APIKEY).toBeUndefined();
    });

    test("blocks _BEARER suffix", () => {
      const env = withEnv({ SERVICE_BEARER: "secret-bearer" }, createSafeEnv);
      expect(env.SERVICE_BEARER).toBeUndefined();
    });

    test("blocks _OAUTH suffix", () => {
      const env = withEnv({ GOOGLE_OAUTH: "secret-oauth" }, createSafeEnv);
      expect(env.GOOGLE_OAUTH).toBeUndefined();
    });

    test("blocks _REFRESH suffix", () => {
      const env = withEnv({ TOKEN_REFRESH: "secret-refresh" }, createSafeEnv);
      expect(env.TOKEN_REFRESH).toBeUndefined();
    });

    test("blocks _SESSION suffix", () => {
      const env = withEnv({ USER_SESSION: "secret-session" }, createSafeEnv);
      expect(env.USER_SESSION).toBeUndefined();
    });

    test("blocks _PRIVATE suffix", () => {
      const env = withEnv({ RSA_PRIVATE: "secret-private-key" }, createSafeEnv);
      expect(env.RSA_PRIVATE).toBeUndefined();
    });

    test("blocks _CREDENTIAL suffix", () => {
      const env = withEnv(
        { SERVICE_CREDENTIAL: "secret-credential" },
        createSafeEnv
      );
      expect(env.SERVICE_CREDENTIAL).toBeUndefined();
    });

    test("blocks _CREDENTIALS suffix", () => {
      const env = withEnv(
        { AWS_CREDENTIALS: "secret-credentials" },
        createSafeEnv
      );
      expect(env.AWS_CREDENTIALS).toBeUndefined();
    });
  });

  describe("suffix case sensitivity", () => {
    test("blocks lowercase suffix (converted to uppercase for check)", () => {
      const env = withEnv({ api_key: "secret" }, createSafeEnv);
      expect(env.api_key).toBeUndefined();
    });

    test("blocks mixed case suffix", () => {
      const env = withEnv({ Api_Key: "secret" }, createSafeEnv);
      expect(env.Api_Key).toBeUndefined();
    });

    test("blocks uppercase suffix", () => {
      const env = withEnv({ API_KEY: "secret" }, createSafeEnv);
      expect(env.API_KEY).toBeUndefined();
    });
  });

  describe("non-allowlisted variables", () => {
    test("excludes variables not in allowlist", () => {
      const env = withEnv({ CUSTOM_VAR: "custom-value" }, createSafeEnv);
      expect(env.CUSTOM_VAR).toBeUndefined();
    });

    test("excludes unknown env vars even without blocked suffix", () => {
      const env = withEnv({ MY_CUSTOM_SETTING: "value" }, createSafeEnv);
      expect(env.MY_CUSTOM_SETTING).toBeUndefined();
    });
  });

  describe("undefined values", () => {
    test("does not include undefined values", () => {
      const env = createSafeEnv();
      const keys = Object.keys(env);
      for (const key of keys) {
        expect(env[key]).toBeDefined();
      }
    });
  });

  test("verifies all expected allowed vars are in ALLOWED_ENV_VARS", () => {
    const expectedVars = [
      "PATH",
      "HOME",
      "USER",
      "TMPDIR",
      "TEMP",
      "TMP",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "SHELL",
      "TERM",
      "GOPATH",
      "GOROOT",
      "GOCACHE",
      "GOMODCACHE",
      "CGO_ENABLED",
      "NODE_ENV",
      "NODE_PATH",
      "NPM_CONFIG_CACHE",
      "CARGO_HOME",
      "RUSTUP_HOME",
      "JAVA_HOME",
      "MAVEN_HOME",
      "GRADLE_HOME",
    ];

    for (const v of expectedVars) {
      expect(ALLOWED_ENV_VARS.has(v)).toBe(true);
    }
    expect(ALLOWED_ENV_VARS.size).toBe(24);
  });

  test("verifies all blocked suffixes are in BLOCKED_ENV_SUFFIXES", () => {
    const expectedSuffixes = [
      "_KEY",
      "_TOKEN",
      "_SECRET",
      "_PASSWORD",
      "_CREDS",
      "_AUTH",
      "_API",
      "_APIKEY",
      "_BEARER",
      "_OAUTH",
      "_REFRESH",
      "_SESSION",
      "_PRIVATE",
      "_CREDENTIAL",
      "_CREDENTIALS",
    ];

    for (const suffix of expectedSuffixes) {
      expect(BLOCKED_ENV_SUFFIXES).toContain(suffix);
    }
    expect(BLOCKED_ENV_SUFFIXES).toHaveLength(15);
  });
});

describe("validateCommand", () => {
  describe("blocked bytes check (first)", () => {
    test("rejects null byte", () => {
      const result = validateCommand("cmd\x00arg");
      expect(result).toBe("command contains invalid characters");
    });

    test("rejects newline", () => {
      const result = validateCommand("cmd\narg");
      expect(result).toBe("command contains invalid characters");
    });

    test("rejects carriage return", () => {
      const result = validateCommand("cmd\rarg");
      expect(result).toBe("command contains invalid characters");
    });
  });

  describe("blocked patterns check (second)", () => {
    test("rejects rm -rf", () => {
      const result = validateCommand("rm -rf ./dir");
      expect(result).toBe('blocked pattern: "rm -rf"');
    });

    test("rejects pipe operator", () => {
      const result = validateCommand("cat file | grep");
      expect(result).toBe('blocked pattern: "|"');
    });

    test("rejects command substitution", () => {
      const result = validateCommand("echo $(whoami)");
      expect(result).toBe('blocked pattern: "$("');
    });
  });

  describe("blocked commands check (third)", () => {
    test("rejects rm command", () => {
      const result = validateCommand("rm file.txt");
      expect(result).toBe('blocked command: "rm"');
    });

    test("rejects sudo command", () => {
      const result = validateCommand("sudo ls");
      expect(result).toBe('blocked pattern: "sudo"');
    });

    test("rejects sh command", () => {
      const result = validateCommand("sh script.sh");
      expect(result).toBe('blocked command: "sh"');
    });

    test("rejects bash command", () => {
      const result = validateCommand("bash script.sh");
      expect(result).toBe('blocked command: "bash"');
    });

    test("rejects zsh command", () => {
      const result = validateCommand("zsh script.sh");
      expect(result).toBe('blocked command: "zsh"');
    });

    test("rejects fish command", () => {
      const result = validateCommand("fish script.sh");
      expect(result).toBe('blocked command: "fish"');
    });

    test("rejects dash command", () => {
      const result = validateCommand("dash script.sh");
      expect(result).toBe('blocked command: "dash"');
    });

    test("rejects absolute path to blocked command", () => {
      const result = validateCommand("/usr/bin/rm file.txt");
      expect(result).toBe('blocked command: "rm"');
    });

    test("rejects relative path to blocked command", () => {
      const result = validateCommand("./scripts/rm file.txt");
      expect(result).toBe('blocked command: "rm"');
    });
  });

  describe("empty command check (fourth)", () => {
    test("rejects empty string", () => {
      const result = validateCommand("");
      expect(result).toBe("empty command");
    });

    test("rejects whitespace-only string", () => {
      const result = validateCommand("   ");
      expect(result).toBe("empty command");
    });

    test("rejects tabs-only string", () => {
      const result = validateCommand("\t\t");
      expect(result).toBe("empty command");
    });
  });

  describe("valid commands pass", () => {
    test("accepts go build", () => {
      const result = validateCommand("go build ./...");
      expect(result).toBe(null);
    });

    test("accepts npm test", () => {
      const result = validateCommand("npm test");
      expect(result).toBe(null);
    });

    test("accepts cargo check", () => {
      const result = validateCommand("cargo check");
      expect(result).toBe(null);
    });

    test("accepts bun run", () => {
      const result = validateCommand("bun run build");
      expect(result).toBe(null);
    });

    test("accepts git status", () => {
      const result = validateCommand("git status");
      expect(result).toBe(null);
    });

    test("accepts git diff", () => {
      const result = validateCommand("git diff HEAD");
      expect(result).toBe(null);
    });
  });

  describe("check order verification", () => {
    test("bytes check runs before pattern check (null byte in rm -rf)", () => {
      const result = validateCommand("rm\x00-rf");
      expect(result).toBe("command contains invalid characters");
    });

    test("pattern check runs before command check (sudo with valid chars)", () => {
      const result = validateCommand("sudo rm");
      expect(result).toBe('blocked pattern: "sudo"');
    });
  });

  test("verifies BLOCKED_COMMANDS contains expected commands", () => {
    const expectedCommands = [
      "rm",
      "sudo",
      "chmod",
      "chown",
      "curl",
      "wget",
      "ssh",
      "scp",
      "nc",
      "netcat",
      "eval",
      "exec",
      "sh",
      "bash",
      "zsh",
      "fish",
      "dash",
    ];

    for (const cmd of expectedCommands) {
      expect(BLOCKED_COMMANDS.has(cmd)).toBe(true);
    }
    expect(BLOCKED_COMMANDS.size).toBe(17);
  });
});

describe("parseCommand", () => {
  test("returns normalized command", () => {
    const result = parseCommand("go   build");
    expect(result.normalized).toBe("go build");
  });

  test("returns parts array", () => {
    const result = parseCommand("go build ./...");
    expect(result.parts).toEqual(["go", "build", "./..."]);
  });

  test("handles extra whitespace (preserves leading/trailing)", () => {
    const result = parseCommand("  npm   run   test  ");
    expect(result.normalized).toBe(" npm run test ");
    expect(result.parts).toEqual(["npm", "run", "test"]);
  });

  test("handles empty string", () => {
    const result = parseCommand("");
    expect(result.normalized).toBe("");
    expect(result.parts).toEqual([]);
  });

  test("handles whitespace-only string", () => {
    const result = parseCommand("   ");
    expect(result.normalized).toBe(" ");
    expect(result.parts).toEqual([]);
  });

  test("handles single command", () => {
    const result = parseCommand("ls");
    expect(result.normalized).toBe("ls");
    expect(result.parts).toEqual(["ls"]);
  });

  test("handles command with many arguments", () => {
    const result = parseCommand("npm run test -- --coverage --watch");
    expect(result.normalized).toBe("npm run test -- --coverage --watch");
    expect(result.parts).toEqual([
      "npm",
      "run",
      "test",
      "--",
      "--coverage",
      "--watch",
    ]);
  });

  test("handles tabs in command", () => {
    const result = parseCommand("go\tbuild\t./...");
    expect(result.normalized).toBe("go build ./...");
    expect(result.parts).toEqual(["go", "build", "./..."]);
  });
});
