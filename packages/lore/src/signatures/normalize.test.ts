import { describe, expect, test } from "vitest";
import { generateFingerprints } from "./index.js";
import { normalizeFilePath, normalizeForLore } from "./normalize.js";

describe("normalizeForLore", () => {
  test("normalizes quoted strings", () => {
    expect(normalizeForLore("Type 'UserProfile' is not assignable")).toBe(
      "Type <string> is not assignable"
    );
  });

  test("normalizes scoped packages", () => {
    expect(normalizeForLore("Cannot find module @acme/utils")).toBe(
      "Cannot find module <module>"
    );
  });

  test("normalizes numbers but preserves error codes", () => {
    expect(normalizeForLore("error TS2322: at line 42")).toBe(
      "error TS2322: at line <n>"
    );
  });

  test("normalizes absolute paths", () => {
    expect(normalizeForLore("Error in /Users/john/project/src/app.ts")).toBe(
      "Error in <home><path>"
    );
  });

  test("collapses whitespace", () => {
    expect(normalizeForLore("Error:   multiple   spaces")).toBe(
      "Error: multiple spaces"
    );
  });

  test("truncates long messages", () => {
    const long = "x".repeat(600);
    expect(normalizeForLore(long).length).toBe(500);
  });

  // Security: Sensitive data sanitization
  describe("sensitive data sanitization", () => {
    test("sanitizes API keys", () => {
      expect(normalizeForLore("api_key=sk_live_abcdef123456")).toBe("<secret>");
      expect(normalizeForLore("token: ghp_xxxxxxxxxxxx")).toBe("<secret>");
    });

    test("sanitizes JWT tokens", () => {
      expect(
        normalizeForLore(
          "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature"
        )
      ).toBe("Bearer <token>");
    });

    test("sanitizes AWS keys", () => {
      expect(
        normalizeForLore("Found key: AKIAIOSFODNN7EXAMPLE in config")
      ).toBe("Found key: <aws-key> in config");
    });

    test("sanitizes email addresses", () => {
      expect(normalizeForLore("Contact user@example.com for help")).toBe(
        "Contact <email> for help"
      );
    });

    test("sanitizes IP addresses", () => {
      expect(normalizeForLore("Connection to 192.168.1.100 failed")).toBe(
        "Connection to <ip> failed"
      );
    });

    test("sanitizes home directory paths", () => {
      expect(normalizeForLore("Error in /Users/john/project/file.ts")).toBe(
        "Error in <home><path>"
      );
      expect(normalizeForLore("Error in /home/alice/.config")).toBe(
        "Error in <home><path>"
      );
    });

    test("sanitizes long hex tokens (48+ chars, like SHA-256)", () => {
      // SHA-256 is 64 chars, should be sanitized
      expect(
        normalizeForLore(
          "Hash: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
        )
      ).toBe("Hash: <hex>");
    });

    test("preserves commit SHAs and short hashes (40 chars and below)", () => {
      // Git SHA is 40 chars, should NOT be sanitized (might be a legitimate commit SHA)
      expect(
        normalizeForLore("Commit: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")
      ).toBe("Commit: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2");
    });

    test("sanitizes hex tokens with sensitive context (key=, token:, etc.)", () => {
      // Shorter hex strings with sensitive context are caught by API_KEYS pattern as <secret>
      // This is the expected behavior since API_KEYS is more specific
      expect(normalizeForLore("secret: a1b2c3d4e5f6a1b2c3d4")).toBe("<secret>");
      expect(normalizeForLore("token=deadbeef01234567")).toBe("<secret>");
      // CONTEXTUAL_HEX catches hex-only patterns (no alphanumeric in value)
      expect(normalizeForLore("key=a1b2c3d4e5f6a1b2")).toBe("<hex>");
    });
  });

  // Security: ReDoS prevention
  describe("ReDoS prevention", () => {
    test("handles very long input without hanging", () => {
      const start = Date.now();
      const longInput = "x".repeat(100_000);
      normalizeForLore(longInput);
      const elapsed = Date.now() - start;
      // Should complete in under 100ms even with 100k chars
      expect(elapsed).toBeLessThan(100);
    });

    test("truncates input before regex processing", () => {
      // Input with pattern that could cause backtracking
      const adversarial = `/${"a/".repeat(5000)}`;
      const start = Date.now();
      normalizeForLore(adversarial);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
    });
  });
});

describe("normalizeFilePath", () => {
  test("strips prefix and keeps relative path", () => {
    // COMMON_PATH_PREFIXES strips everything before src/, removing usernames
    expect(
      normalizeFilePath("/Users/john/project/src/components/Button.tsx")
    ).toBe("src/components/button.tsx");
  });

  test("normalizes windows paths", () => {
    expect(normalizeFilePath("C:\\Users\\john\\project\\src\\app.ts")).toBe(
      "src/app.ts"
    );
  });

  test("strips home directory from paths without common markers", () => {
    // When no common markers (src/lib/app/etc), strip home dir for privacy
    expect(normalizeFilePath("/Users/alice/code/index.ts")).toBe(
      "/code/index.ts"
    );
    expect(normalizeFilePath("/home/bob/.config/app.json")).toBe(
      "/.config/app.json"
    );
  });

  test("handles paths without home directories", () => {
    expect(normalizeFilePath("/var/www/src/app.ts")).toBe("src/app.ts");
    expect(normalizeFilePath("src/components/Button.tsx")).toBe(
      "src/components/button.tsx"
    );
  });

  test("handles paths with common markers correctly", () => {
    // These should all normalize to paths starting with the marker
    expect(normalizeFilePath("/home/user/my-project/lib/utils.ts")).toBe(
      "lib/utils.ts"
    );
    expect(normalizeFilePath("C:\\Users\\dev\\code\\app\\index.tsx")).toBe(
      "app/index.tsx"
    );
    expect(normalizeFilePath("/opt/work/packages/core/src/main.ts")).toBe(
      "packages/core/src/main.ts"
    );
  });
});

describe("generateFingerprints", () => {
  test("same error from different repos produces same lore fingerprint", () => {
    const error1 = {
      message: "Type 'string' is not assignable to type 'number'",
      source: "typescript" as const,
      ruleId: "TS2322",
      filePath: "/Users/alice/repo-a/src/utils.ts",
      line: 10,
    };
    const error2 = {
      message: "Type 'string' is not assignable to type 'number'",
      source: "typescript" as const,
      ruleId: "TS2322",
      filePath: "/home/bob/repo-b/src/utils.ts",
      line: 25,
    };

    const fp1 = generateFingerprints(error1);
    const fp2 = generateFingerprints(error2);

    expect(fp1.lore).toBe(fp2.lore); // Same lore fingerprint
    expect(fp1.repo).toBe(fp2.repo); // Same repo fingerprint (both normalize to src/utils.ts)
    expect(fp1.instance).not.toBe(fp2.instance); // Different instance (different line)
  });

  test("same relative path produces same repo fingerprint", () => {
    const error1 = {
      message: "Type 'string' is not assignable to type 'number'",
      source: "typescript" as const,
      ruleId: "TS2322",
      filePath: "/var/www/project/src/utils.ts",
      line: 10,
    };
    const error2 = {
      message: "Type 'string' is not assignable to type 'number'",
      source: "typescript" as const,
      ruleId: "TS2322",
      filePath: "/different/base/path/src/utils.ts",
      line: 25,
    };

    const fp1 = generateFingerprints(error1);
    const fp2 = generateFingerprints(error2);

    expect(fp1.lore).toBe(fp2.lore); // Same lore fingerprint
    expect(fp1.repo).toBe(fp2.repo); // Same repo fingerprint (both normalize to src/utils.ts)
    expect(fp1.instance).not.toBe(fp2.instance); // Different instance (different line)
  });

  test("different errors produce different fingerprints", () => {
    const error1 = {
      message: "Type error",
      source: "typescript" as const,
      ruleId: "TS2322",
    };
    const error2 = {
      message: "Lint error",
      source: "biome" as const,
      ruleId: "noVar",
    };

    const fp1 = generateFingerprints(error1);
    const fp2 = generateFingerprints(error2);

    expect(fp1.lore).not.toBe(fp2.lore);
  });
});
