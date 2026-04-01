import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  blobToArrayBuffer,
  extractLogsFromZip,
  LogExtractionError,
} from "./log-extractor";

// Helper to create a zip buffer from files
const createZipBuffer = (files: Record<string, string>): ArrayBuffer => {
  const encoder = new TextEncoder();
  const zipFiles: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    zipFiles[name] = encoder.encode(content);
  }
  // Cast to ArrayBuffer since zipSync returns Uint8Array with ArrayBufferLike buffer
  return zipSync(zipFiles).buffer as ArrayBuffer;
};

describe("extractLogsFromZip", () => {
  describe("successful extraction", () => {
    it("extracts logs from a single-file zip", () => {
      const zipBuffer = createZipBuffer({
        "job1.txt": "Line 1\nLine 2\nLine 3",
      });

      const result = extractLogsFromZip(zipBuffer);

      expect(result.logs).toBe("Line 1\nLine 2\nLine 3");
      expect(result.jobCount).toBe(1);
      expect(result.totalBytes).toBeGreaterThan(0);
    });

    it("concatenates logs from multiple files with newlines", () => {
      const zipBuffer = createZipBuffer({
        "job1.txt": "Job 1 output",
        "job2.txt": "Job 2 output",
      });

      const result = extractLogsFromZip(zipBuffer);

      expect(result.logs).toContain("Job 1 output");
      expect(result.logs).toContain("Job 2 output");
      expect(result.jobCount).toBe(2);
    });

    it("sorts files alphabetically for consistent ordering", () => {
      const zipBuffer = createZipBuffer({
        "z-last.txt": "Z content",
        "a-first.txt": "A content",
        "m-middle.txt": "M content",
      });

      const result = extractLogsFromZip(zipBuffer);

      // Should be in alphabetical order
      const firstContent = result.logs.indexOf("A content");
      const middleContent = result.logs.indexOf("M content");
      const lastContent = result.logs.indexOf("Z content");

      expect(firstContent).toBeLessThan(middleContent);
      expect(middleContent).toBeLessThan(lastContent);
    });

    it("ignores directory entries in zip", () => {
      // Create zip with a directory entry (ends with /)
      const encoder = new TextEncoder();
      const zipBuffer = zipSync({
        "dir/": new Uint8Array(0), // Directory entry
        "dir/file.txt": encoder.encode("File content"),
      }).buffer as ArrayBuffer;

      const result = extractLogsFromZip(zipBuffer);

      expect(result.jobCount).toBe(1);
      expect(result.logs).toBe("File content");
    });
  });

  describe("error handling", () => {
    it("throws INVALID_ZIP for non-zip data", () => {
      const invalidBuffer = new TextEncoder().encode("not a zip file")
        .buffer as ArrayBuffer;

      expect(() => extractLogsFromZip(invalidBuffer)).toThrow(
        LogExtractionError
      );
      expect(() => extractLogsFromZip(invalidBuffer)).toThrow(
        "Invalid zip payload"
      );
    });

    it("throws EMPTY_ARCHIVE for zip with no files", () => {
      // Create an empty zip (just directory entries)
      const emptyZip = zipSync({}).buffer as ArrayBuffer;

      expect(() => extractLogsFromZip(emptyZip)).toThrow(LogExtractionError);
      expect(() => extractLogsFromZip(emptyZip)).toThrow("no files");
    });

    it("includes error code in LogExtractionError", () => {
      const invalidBuffer = new TextEncoder().encode("not a zip")
        .buffer as ArrayBuffer;

      try {
        extractLogsFromZip(invalidBuffer);
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(LogExtractionError);
        expect((error as LogExtractionError).code).toBe("INVALID_ZIP");
      }
    });
  });

  describe("edge cases", () => {
    it("handles empty log files", () => {
      const zipBuffer = createZipBuffer({
        "empty.txt": "",
        "nonempty.txt": "Some content",
      });

      const result = extractLogsFromZip(zipBuffer);

      expect(result.jobCount).toBe(2);
      expect(result.logs).toContain("Some content");
    });

    it("handles unicode content in logs", () => {
      const zipBuffer = createZipBuffer({
        "unicode.txt": "Error: 日本語 emoji 🎉 and symbols ≠≤≥",
      });

      const result = extractLogsFromZip(zipBuffer);

      expect(result.logs).toContain("日本語");
      expect(result.logs).toContain("🎉");
      expect(result.logs).toContain("≠≤≥");
    });

    it("handles very large filenames", () => {
      const longName = `${"a".repeat(200)}.txt`;
      const zipBuffer = createZipBuffer({
        [longName]: "Content with long filename",
      });

      const result = extractLogsFromZip(zipBuffer);

      expect(result.logs).toBe("Content with long filename");
      expect(result.jobCount).toBe(1);
    });
  });
});

describe("blobToArrayBuffer", () => {
  it("converts Blob to ArrayBuffer", async () => {
    const content = "Hello, World!";
    const blob = new Blob([content], { type: "text/plain" });

    const buffer = await blobToArrayBuffer(blob);

    const decoder = new TextDecoder();
    expect(decoder.decode(buffer)).toBe(content);
  });
});
