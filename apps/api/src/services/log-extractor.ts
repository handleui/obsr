// Log extractor for GitHub Actions workflow logs
// Extracts and concatenates logs from zip archives returned by GitHub API
//
// Performance notes (Cloudflare Workers - 128MB limit):
// - Pre-scan validates headers before decompression (zip bomb protection)
// - Single unzipSync call for actual extraction with filter
// - Pre-allocates result array with known size
// - Reuses single TextDecoder instance

import { unzipSync } from "fflate";

// Maximum sizes for security (same as parse.ts)
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ZIP_SIZE = 30 * 1024 * 1024; // 30MB
// Maximum compression ratio for zip bomb detection
// Text logs typically compress 5-10x, but highly repetitive logs can reach 200-500x
// We use 1000x as a generous threshold since post-decompression size check provides defense in depth
const MAX_COMPRESSION_RATIO = 1000;
// Maximum number of files in archive (prevents "zip of many files" attack)
const MAX_FILE_COUNT = 1000;

export interface LogExtractionResult {
  logs: string;
  totalBytes: number;
  jobCount: number;
}

export type LogExtractionErrorCode =
  | "INVALID_ZIP"
  | "EMPTY_ARCHIVE"
  | "SIZE_EXCEEDED"
  | "ZIP_BOMB_DETECTED"
  | "TOO_MANY_FILES";

export class LogExtractionError extends Error {
  readonly code: LogExtractionErrorCode;

  constructor(message: string, code: LogExtractionErrorCode) {
    super(message);
    this.name = "LogExtractionError";
    this.code = code;
  }
}

// Check ZIP magic bytes
const isZip = (data: Uint8Array): boolean =>
  data.length >= 4 &&
  data[0] === 0x50 &&
  data[1] === 0x4b &&
  (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07);

// Metadata collected during header scan
interface ZipScanResult {
  declaredSize: number;
  compressedSize: number;
  entryCount: number;
  fileNames: string[];
}

// Pre-scan ZIP headers to validate sizes before decompression (zip bomb protection)
// Also collects file names to avoid re-scanning during extraction
const scanZipHeaders = (bytes: Uint8Array): ZipScanResult => {
  let declaredSize = 0;
  let compressedSize = 0;
  const fileNames: string[] = [];

  unzipSync(bytes, {
    filter(file) {
      // Skip directories
      if (!file.name.endsWith("/")) {
        declaredSize += file.originalSize ?? 0;
        compressedSize += file.size ?? 0;
        fileNames.push(file.name);
      }
      return false; // Don't decompress during scan phase
    },
  });

  return {
    declaredSize,
    compressedSize,
    entryCount: fileNames.length,
    fileNames,
  };
};

// Extract logs from GitHub Actions zip archive
// GitHub returns a zip with one .txt file per job
export const extractLogsFromZip = (
  zipBuffer: ArrayBuffer
): LogExtractionResult => {
  const bytes = new Uint8Array(zipBuffer);

  // Validate ZIP format
  if (!isZip(bytes)) {
    throw new LogExtractionError("Invalid zip payload", "INVALID_ZIP");
  }

  // Validate input size
  if (bytes.byteLength > MAX_ZIP_SIZE) {
    throw new LogExtractionError(
      `Zip archive exceeds maximum size of ${MAX_ZIP_SIZE} bytes`,
      "SIZE_EXCEEDED"
    );
  }

  // Pre-scan: Validate ZIP entry sizes before decompression (zip bomb protection)
  const { declaredSize, compressedSize, entryCount, fileNames } =
    scanZipHeaders(bytes);

  if (entryCount === 0) {
    throw new LogExtractionError(
      "Zip archive contained no files",
      "EMPTY_ARCHIVE"
    );
  }

  // Guard: Reject archives with too many files (prevents "zip of many files" attack)
  if (entryCount > MAX_FILE_COUNT) {
    throw new LogExtractionError(
      `Zip archive contains too many files (${entryCount}, max ${MAX_FILE_COUNT})`,
      "TOO_MANY_FILES"
    );
  }

  // Guard: Reject if declared uncompressed size exceeds limit
  // Note: Headers can lie, so this is just a first-pass check
  if (declaredSize > MAX_LOG_SIZE) {
    throw new LogExtractionError(
      `Logs exceed maximum size of ${MAX_LOG_SIZE} bytes`,
      "SIZE_EXCEEDED"
    );
  }

  // Guard: Detect potential zip bombs via compression ratio
  // A zip bomb has high compression ratio (declared >> compressed)
  // The post-decompression size check provides defense in depth for actual extracted size
  if (compressedSize > 0) {
    const declaredRatio = declaredSize / compressedSize;

    // Declared ratio is suspiciously high (>100x is unusual for text logs)
    if (declaredRatio > MAX_COMPRESSION_RATIO) {
      throw new LogExtractionError(
        `Zip archive has suspicious compression ratio (${declaredRatio.toFixed(1)}x)`,
        "ZIP_BOMB_DETECTED"
      );
    }
  }

  // Safe to decompress - headers have been validated
  // Use filter to only extract non-directory files
  const unzipped = unzipSync(bytes, {
    filter(file) {
      return !file.name.endsWith("/");
    },
  });

  // Sort file names for consistent ordering (GitHub names files by job)
  // Use pre-collected fileNames from scan to avoid Object.keys allocation
  const sortedNames = fileNames.sort((a, b) => a.localeCompare(b));

  // Post-decompression size check (defense in depth)
  let totalBytes = 0;
  for (const name of sortedNames) {
    const data = unzipped[name];
    // Skip if file was filtered out (shouldn't happen, but defensive)
    if (!data) {
      continue;
    }
    totalBytes += data.length;
    if (totalBytes > MAX_LOG_SIZE) {
      throw new LogExtractionError(
        `Logs exceed maximum size of ${MAX_LOG_SIZE} bytes`,
        "SIZE_EXCEEDED"
      );
    }
  }

  // Decode all files using single TextDecoder instance
  // Pre-allocate array with known size for better performance
  const decoder = new TextDecoder();
  const parts: string[] = [];
  for (const name of sortedNames) {
    const data = unzipped[name];
    if (data) {
      parts.push(decoder.decode(data));
    }
  }

  // Account for newline separators in total bytes
  const separatorBytes = sortedNames.length > 1 ? sortedNames.length - 1 : 0;

  return {
    logs: parts.join("\n"),
    totalBytes: totalBytes + separatorBytes,
    jobCount: sortedNames.length,
  };
};

// Convert a Blob to ArrayBuffer (for use with GitHub API response)
export const blobToArrayBuffer = (blob: Blob): Promise<ArrayBuffer> => {
  return blob.arrayBuffer();
};
