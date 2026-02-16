import { describe, expect, test } from "vitest";
import { extractRelatedFiles } from "./related-files.js";

describe("extractRelatedFiles", () => {
  test("returns empty array for undefined input", () => {
    expect(extractRelatedFiles(undefined)).toEqual([]);
    expect(extractRelatedFiles(null)).toEqual([]);
  });

  test("extracts Node.js stack trace paths", () => {
    const stackTrace = `
Error: Something went wrong
    at Object.<anonymous> (/app/src/utils/helper.ts:10:5)
    at Module._compile (node:internal/modules/cjs/loader:1376:14)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async loadConfig (/app/src/config/index.ts:25:3)
`;
    const result = extractRelatedFiles(stackTrace, "/app/src/main.ts");
    expect(result).toContain("/app/src/utils/helper.ts");
    expect(result).toContain("/app/src/config/index.ts");
    expect(result.some((p) => p.includes("node:"))).toBe(false);
  });

  test("extracts Python stack trace paths", () => {
    const stackTrace = `
Traceback (most recent call last):
  File "/app/main.py", line 10, in <module>
    import helper
  File "/app/utils/helper.py", line 5, in helper
    raise ValueError("test")
ValueError: test
`;
    const result = extractRelatedFiles(stackTrace);
    expect(result).toContain("/app/main.py");
    expect(result).toContain("/app/utils/helper.py");
  });

  test("excludes node_modules paths", () => {
    const stackTrace = `
Error: Module not found
    at resolve (/app/node_modules/some-pkg/index.js:10:5)
    at loadModule (/app/src/loader.ts:15:3)
`;
    const result = extractRelatedFiles(stackTrace);
    expect(result).toContain("/app/src/loader.ts");
    expect(result.some((p) => p.includes("node_modules"))).toBe(false);
  });

  test("excludes primary file from results", () => {
    const stackTrace = `
    at main (/app/src/index.ts:5:1)
    at helper (/app/src/utils.ts:10:3)
`;
    const result = extractRelatedFiles(stackTrace, "/app/src/index.ts");
    expect(result).not.toContain("/app/src/index.ts");
    expect(result).toContain("/app/src/utils.ts");
  });

  test("deduplicates file paths", () => {
    const stackTrace = `
    at fn1 (/app/src/utils.ts:10:3)
    at fn2 (/app/src/utils.ts:20:5)
    at fn3 (/app/src/utils.ts:30:7)
`;
    const result = extractRelatedFiles(stackTrace);
    const utilsCount = result.filter((p) => p.includes("utils.ts")).length;
    expect(utilsCount).toBe(1);
  });

  test("limits to MAX_RELATED_FILES", () => {
    const files = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
    const stackTrace = files
      .map((f, i) => `    at fn${i} (/app/src/${f}:${i + 1}:1)`)
      .join("\n");
    const result = extractRelatedFiles(stackTrace);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  test("handles Go-style file paths", () => {
    const stackTrace = `
panic: runtime error: invalid memory address
goroutine 1 [running]:
main.doSomething()
        /app/cmd/server/main.go:42 +0x45
main.main()
        /app/cmd/server/handler.go:15 +0x20
`;
    const result = extractRelatedFiles(stackTrace);
    expect(result).toContain("/app/cmd/server/main.go");
    expect(result).toContain("/app/cmd/server/handler.go");
  });

  test("extracts Windows absolute paths", () => {
    const stackTrace = `Error: Something went wrong
    at Object.<anonymous> (C:\\Users\\project\\src\\helper.ts:10:5)
    at Module._compile (node:internal/modules/cjs/loader:1376:14)`;
    const result = extractRelatedFiles(stackTrace);
    expect(result).toContain("C:/Users/project/src/helper.ts");
  });

  test("excludes Windows node_modules paths", () => {
    const stackTrace = `    at resolve (C:\\Users\\project\\node_modules\\pkg\\index.js:10:5)
    at loadModule (C:\\Users\\project\\src\\loader.ts:15:3)`;
    const result = extractRelatedFiles(stackTrace);
    expect(result).toContain("C:/Users/project/src/loader.ts");
    expect(result.every((p) => !p.includes("node_modules"))).toBe(true);
  });

  test("extracts file paths from GitHub Actions annotations", () => {
    const stackTrace =
      "::error file=src/components/Button.tsx,line=42,col=5::Type error";
    const result = extractRelatedFiles(stackTrace);
    expect(result).toContain("src/components/Button.tsx");
  });

  test("extracts file paths from GitHub Actions warnings", () => {
    const stackTrace = "::warning file=lib/utils.ts,line=10::Deprecated API";
    const result = extractRelatedFiles(stackTrace);
    expect(result).toContain("lib/utils.ts");
  });

  describe("path traversal protection", () => {
    test("rejects literal .. traversal", () => {
      const stackTrace = "    at fn (/app/../etc/passwd.ts:1:1)";
      const result = extractRelatedFiles(stackTrace);
      expect(result).toEqual([]);
    });

    test("rejects URL-encoded traversal (%2e%2e)", () => {
      const stackTrace = "    at fn (/app/%2e%2e/etc/passwd.ts:1:1)";
      const result = extractRelatedFiles(stackTrace);
      expect(result).toEqual([]);
    });

    test("rejects backslash traversal variants", () => {
      const stackTrace = "    at fn (/app/..\\etc\\passwd.ts:1:1)";
      const result = extractRelatedFiles(stackTrace);
      expect(result).toEqual([]);
    });

    test("rejects null bytes in path", () => {
      const stackTrace = "    at fn (/app/safe\0/../etc/passwd.ts:1:1)";
      const result = extractRelatedFiles(stackTrace);
      expect(result).toEqual([]);
    });

    test("rejects invalid URL encoding", () => {
      const stackTrace = "    at fn (/app/%ZZ/file.ts:1:1)";
      const result = extractRelatedFiles(stackTrace);
      expect(result).toEqual([]);
    });

    test("allows safe paths with dots in filenames", () => {
      const stackTrace = "    at fn (/app/src/config.service.ts:1:1)";
      const result = extractRelatedFiles(stackTrace);
      expect(result).toContain("/app/src/config.service.ts");
    });
  });
});
