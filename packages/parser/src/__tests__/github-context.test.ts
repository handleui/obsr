/**
 * Tests for the GitHub Actions context parser step tracking.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createGitHubContextParser, githubParser } from "../context/github.js";
import type { ContextParser } from "../context/types.js";

// ============================================================================
// Test Fixtures
// ============================================================================

const TIMESTAMP = "2024-01-15T10:30:45.1234567Z";

// Step markers
const stepRunNpmLint = `${TIMESTAMP} ##[group]Run npm run lint`;
const stepRunNpmTest = `${TIMESTAMP} ##[group]Run npm test`;
const stepCheckout = `${TIMESTAMP} ##[group]Run actions/checkout@v4`;
const stepPostCheckout = `${TIMESTAMP} ##[group]Post actions/checkout@v4`;
const stepSetupNode = `${TIMESTAMP} ##[group]Run actions/setup-node@v4`;
const stepSetUpJob = `${TIMESTAMP} ##[group]Set up job`;
const stepCompleteJob = `${TIMESTAMP} ##[group]Complete job`;
const stepEndGroup = `${TIMESTAMP} ##[endgroup]`;

// Content lines
const errorLine = `${TIMESTAMP} error: unused variable 'x'`;
const tsErrorLine = `${TIMESTAMP} src/main.ts(10,5): error TS2304: Cannot find name 'x'.`;
const normalOutput = `${TIMESTAMP} Installing dependencies...`;

// Noise lines
const debugLine = `${TIMESTAMP} ::debug::Some debug info`;
const userGroupStart = `${TIMESTAMP} ::group::My custom group`;
const userGroupEnd = `${TIMESTAMP} ::endgroup::`;
const emptyLine = `${TIMESTAMP} `;
const otherMarker = `${TIMESTAMP} ##[warning]Some warning`;

// ============================================================================
// Unit Tests for GitHub Parser
// ============================================================================

describe("GitHubParser", () => {
  let parser: ContextParser;

  beforeEach(() => {
    parser = createGitHubContextParser();
  });

  describe("timestamp stripping", () => {
    it("strips ISO 8601 timestamps from lines", () => {
      const result = parser.parseLine(normalOutput);
      expect(result.cleanLine).toBe("Installing dependencies...");
    });

    it("handles lines without timestamps", () => {
      const result = parser.parseLine("no timestamp here");
      expect(result.cleanLine).toBe("no timestamp here");
    });
  });

  describe("step extraction from Run commands", () => {
    it("extracts step name from shell commands", () => {
      const result = parser.parseLine(stepRunNpmLint);
      expect(result.ctx.step).toBe("npm run lint");
      expect(result.ctx.action).toBeUndefined();
      expect(result.skip).toBe(true);
    });

    it("extracts step name from npm test", () => {
      const result = parser.parseLine(stepRunNpmTest);
      expect(result.ctx.step).toBe("npm test");
      expect(result.ctx.action).toBeUndefined();
    });
  });

  describe("step extraction from GitHub Actions", () => {
    it("extracts action name and friendly step from checkout", () => {
      const result = parser.parseLine(stepCheckout);
      expect(result.ctx.step).toBe("checkout");
      expect(result.ctx.action).toBe("actions/checkout@v4");
      expect(result.skip).toBe(true);
    });

    it("extracts action name from setup-node", () => {
      const result = parser.parseLine(stepSetupNode);
      expect(result.ctx.step).toBe("setup-node");
      expect(result.ctx.action).toBe("actions/setup-node@v4");
    });

    it("handles Post action steps", () => {
      const result = parser.parseLine(stepPostCheckout);
      expect(result.ctx.step).toBe("Post checkout");
      expect(result.ctx.action).toBe("actions/checkout@v4");
    });
  });

  describe("step extraction from built-in steps", () => {
    it("extracts Set up job step", () => {
      const result = parser.parseLine(stepSetUpJob);
      expect(result.ctx.step).toBe("Set up job");
      expect(result.ctx.action).toBeUndefined();
    });

    it("extracts Complete job step", () => {
      const result = parser.parseLine(stepCompleteJob);
      expect(result.ctx.step).toBe("Complete job");
      expect(result.ctx.action).toBeUndefined();
    });
  });

  describe("context preservation for subsequent lines", () => {
    it("preserves step context for error lines", () => {
      parser.parseLine(stepRunNpmLint);
      const result = parser.parseLine(errorLine);

      expect(result.ctx.step).toBe("npm run lint");
      expect(result.skip).toBe(false);
      expect(result.cleanLine).toBe("error: unused variable 'x'");
    });

    it("preserves action context for subsequent lines", () => {
      parser.parseLine(stepCheckout);
      const result = parser.parseLine(normalOutput);

      expect(result.ctx.step).toBe("checkout");
      expect(result.ctx.action).toBe("actions/checkout@v4");
    });

    it("updates context when new step starts", () => {
      parser.parseLine(stepRunNpmLint);
      parser.parseLine(errorLine);
      parser.parseLine(stepEndGroup);
      parser.parseLine(stepRunNpmTest);

      const result = parser.parseLine(errorLine);
      expect(result.ctx.step).toBe("npm test");
    });

    it("preserves context after endgroup", () => {
      parser.parseLine(stepRunNpmLint);
      parser.parseLine(stepEndGroup);

      const result = parser.parseLine(errorLine);
      expect(result.ctx.step).toBe("npm run lint");
    });
  });

  describe("user-created groups do not change step context", () => {
    it("ignores ::group:: markers", () => {
      parser.parseLine(stepRunNpmLint);
      parser.parseLine(userGroupStart);

      const result = parser.parseLine(normalOutput);
      expect(result.ctx.step).toBe("npm run lint");
    });

    it("ignores ::endgroup:: markers", () => {
      parser.parseLine(stepRunNpmLint);
      parser.parseLine(userGroupEnd);

      const result = parser.parseLine(normalOutput);
      expect(result.ctx.step).toBe("npm run lint");
    });
  });

  describe("noise filtering", () => {
    it("marks debug lines as noise", () => {
      const result = parser.parseLine(debugLine);
      expect(result.skip).toBe(true);
      expect(result.ctx.isNoise).toBe(true);
    });

    it("marks user group start as noise", () => {
      const result = parser.parseLine(userGroupStart);
      expect(result.skip).toBe(true);
    });

    it("marks user group end as noise", () => {
      const result = parser.parseLine(userGroupEnd);
      expect(result.skip).toBe(true);
    });

    it("marks empty lines as noise", () => {
      const result = parser.parseLine(emptyLine);
      expect(result.skip).toBe(true);
    });

    it("marks other ##[...] markers as noise", () => {
      const result = parser.parseLine(otherMarker);
      expect(result.skip).toBe(true);
    });

    it("does not mark content lines as noise", () => {
      const result = parser.parseLine(normalOutput);
      expect(result.skip).toBe(false);
      expect(result.ctx.isNoise).toBe(false);
    });

    it("does not mark error lines as noise", () => {
      const result = parser.parseLine(tsErrorLine);
      expect(result.skip).toBe(false);
    });
  });

  describe("reset functionality", () => {
    it("clears step context on reset", () => {
      parser.parseLine(stepRunNpmLint);
      expect(parser.parseLine(normalOutput).ctx.step).toBe("npm run lint");

      parser.reset();

      const result = parser.parseLine(normalOutput);
      expect(result.ctx.step).toBe("");
      expect(result.ctx.action).toBeUndefined();
    });

    it("clears action context on reset", () => {
      parser.parseLine(stepCheckout);
      expect(parser.parseLine(normalOutput).ctx.action).toBe(
        "actions/checkout@v4"
      );

      parser.reset();

      const result = parser.parseLine(normalOutput);
      expect(result.ctx.action).toBeUndefined();
    });
  });
});

// ============================================================================
// Integration Tests with Singleton
// ============================================================================

describe("githubParser singleton", () => {
  beforeEach(() => {
    githubParser.reset();
  });

  it("tracks step context", () => {
    githubParser.parseLine(stepRunNpmLint);
    const result = githubParser.parseLine(errorLine);
    expect(result.ctx.step).toBe("npm run lint");
  });

  it("can be reset", () => {
    githubParser.parseLine(stepRunNpmLint);
    githubParser.reset();
    const result = githubParser.parseLine(errorLine);
    expect(result.ctx.step).toBe("");
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("edge cases", () => {
  let parser: ContextParser;

  beforeEach(() => {
    parser = createGitHubContextParser();
  });

  it("handles action with org prefix (actions/checkout@v4)", () => {
    parser.parseLine(`${TIMESTAMP} ##[group]Run actions/checkout@v4`);
    const result = parser.parseLine(normalOutput);
    expect(result.ctx.step).toBe("checkout");
    expect(result.ctx.action).toBe("actions/checkout@v4");
  });

  it("handles third-party action (dorny/paths-filter@v2)", () => {
    parser.parseLine(`${TIMESTAMP} ##[group]Run dorny/paths-filter@v2`);
    const result = parser.parseLine(normalOutput);
    expect(result.ctx.step).toBe("paths-filter");
    expect(result.ctx.action).toBe("dorny/paths-filter@v2");
  });

  it("handles action without version tag (@main)", () => {
    parser.parseLine(`${TIMESTAMP} ##[group]Run actions/cache@main`);
    const result = parser.parseLine(normalOutput);
    expect(result.ctx.step).toBe("cache");
    expect(result.ctx.action).toBe("actions/cache@main");
  });

  it("handles multi-level action path (google-github-actions/auth@v2)", () => {
    parser.parseLine(`${TIMESTAMP} ##[group]Run google-github-actions/auth@v2`);
    const result = parser.parseLine(normalOutput);
    expect(result.ctx.step).toBe("auth");
    expect(result.ctx.action).toBe("google-github-actions/auth@v2");
  });

  it("handles step with special characters in name", () => {
    parser.parseLine(`${TIMESTAMP} ##[group]Run echo "Hello, World!"`);
    const result = parser.parseLine(normalOutput);
    expect(result.ctx.step).toBe('echo "Hello, World!"');
  });

  it("handles multiple steps in sequence", () => {
    // Step 1
    parser.parseLine(stepCheckout);
    let result = parser.parseLine(normalOutput);
    expect(result.ctx.step).toBe("checkout");

    // End step 1
    parser.parseLine(stepEndGroup);

    // Step 2
    parser.parseLine(stepSetupNode);
    result = parser.parseLine(normalOutput);
    expect(result.ctx.step).toBe("setup-node");

    // End step 2
    parser.parseLine(stepEndGroup);

    // Step 3
    parser.parseLine(stepRunNpmLint);
    result = parser.parseLine(normalOutput);
    expect(result.ctx.step).toBe("npm run lint");
  });

  it("handles line with timestamp but no content", () => {
    const result = parser.parseLine(`${TIMESTAMP} `);
    expect(result.skip).toBe(true);
  });

  it("handles completely empty line", () => {
    const result = parser.parseLine("");
    expect(result.skip).toBe(true);
    expect(result.cleanLine).toBe("");
  });
});

// ============================================================================
// Security Tests
// ============================================================================

describe("security", () => {
  let parser: ContextParser;

  beforeEach(() => {
    parser = createGitHubContextParser();
  });

  describe("step name length limits", () => {
    it("truncates extremely long step names to prevent memory exhaustion", () => {
      // Create a maliciously long step name (1000 chars)
      const longStepName = "a".repeat(1000);
      const maliciousLine = `${TIMESTAMP} ##[group]Run ${longStepName}`;

      parser.parseLine(maliciousLine);
      const result = parser.parseLine(normalOutput);

      // Step name should be truncated (256 chars max including suffix)
      expect(result.ctx.step.length).toBeLessThanOrEqual(256);
      expect(result.ctx.step).toContain("[TRUNCATED]");
    });

    it("does not truncate normal length step names", () => {
      const normalStepName = "npm run lint:check:format:types:test";
      const normalLine = `${TIMESTAMP} ##[group]Run ${normalStepName}`;

      parser.parseLine(normalLine);
      const result = parser.parseLine(normalOutput);

      expect(result.ctx.step).toBe(normalStepName);
      expect(result.ctx.step).not.toContain("[TRUNCATED]");
    });

    it("truncates long action paths in currentAction", () => {
      // Create a long action path (e.g., malicious org/repo name)
      const longOrg = "a".repeat(300);
      const maliciousLine = `${TIMESTAMP} ##[group]Run ${longOrg}/checkout@v4`;

      parser.parseLine(maliciousLine);
      const result = parser.parseLine(normalOutput);

      // Action should be truncated
      expect(result.ctx.action?.length).toBeLessThanOrEqual(256);
      expect(result.ctx.action).toContain("[TRUNCATED]");
    });
  });

  describe("timestamp regex bounds", () => {
    it("handles timestamps with maximum nanosecond digits (9)", () => {
      const maxNanoTimestamp = "2024-01-15T10:30:45.123456789Z ";
      const result = parser.parseLine(`${maxNanoTimestamp}some content`);
      expect(result.cleanLine).toBe("some content");
    });

    it("handles timestamps with minimum nanosecond digits (1)", () => {
      const minNanoTimestamp = "2024-01-15T10:30:45.1Z ";
      const result = parser.parseLine(`${minNanoTimestamp}some content`);
      expect(result.cleanLine).toBe("some content");
    });

    it("does not strip malformed timestamps with too many nano digits", () => {
      // 10+ digits should not be stripped (prevents ReDoS on malformed input)
      const malformedTimestamp = "2024-01-15T10:30:45.1234567890Z ";
      const result = parser.parseLine(`${malformedTimestamp}some content`);
      // The timestamp should remain in the output (not stripped)
      expect(result.cleanLine).toContain("2024-01-15");
    });

    it("handles normal trailing whitespace", () => {
      const result = parser.parseLine(`${TIMESTAMP} content`);
      expect(result.cleanLine).toBe("content");
    });

    it("limits excessive trailing whitespace stripping", () => {
      // More than 10 spaces should not all be stripped (bounded)
      const excessiveWhitespace = `2024-01-15T10:30:45.1234567Z${"  ".repeat(20)}content`;
      const result = parser.parseLine(excessiveWhitespace);
      // Some whitespace should remain (only first 10 stripped)
      expect(result.cleanLine.startsWith(" ")).toBe(true);
    });
  });

  describe("parser state isolation", () => {
    it("new instances start with empty state", () => {
      // Parse something on one instance
      const parser1 = createGitHubContextParser();
      parser1.parseLine(stepRunNpmLint);
      expect(parser1.parseLine(normalOutput).ctx.step).toBe("npm run lint");

      // Create new instance - should be clean
      const parser2 = createGitHubContextParser();
      const result = parser2.parseLine(normalOutput);
      expect(result.ctx.step).toBe("");
    });

    it("reset clears all state completely", () => {
      // Set up state
      parser.parseLine(`${TIMESTAMP} ##[group]Run actions/checkout@v4`);
      const before = parser.parseLine(normalOutput);
      expect(before.ctx.step).toBe("checkout");
      expect(before.ctx.action).toBe("actions/checkout@v4");

      // Reset
      parser.reset();

      // Verify clean state
      const after = parser.parseLine(normalOutput);
      expect(after.ctx.step).toBe("");
      expect(after.ctx.action).toBeUndefined();
    });
  });
});
