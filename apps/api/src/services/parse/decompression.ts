import { unzipSync } from "fflate";
import { DecompressionError } from "./types";

// Maximum log size to prevent DoS (10MB)
export const MAX_LOG_SIZE = 10 * 1024 * 1024;
export const MAX_ZIP_SIZE = 30 * 1024 * 1024;
// Maximum compression ratio for zip bomb detection
// DEFLATE typically achieves 2-10x for text; 100x is very generous
export const MAX_COMPRESSION_RATIO = 100;

export const isZip = (data: Uint8Array): boolean =>
  data.length >= 4 &&
  data[0] === 0x50 &&
  data[1] === 0x4b &&
  (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07);

export const decodeBase64 = (value: string): Uint8Array => {
  const normalized = value.replace(/\s/g, "");
  const decoded = atob(normalized);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
};

export const decodeZip = (bytes: Uint8Array): string => {
  if (!isZip(bytes)) {
    throw new DecompressionError("Invalid zip payload");
  }

  // Pre-scan: Validate ZIP entry sizes before decompression (zip bomb protection)
  // The filter callback receives metadata from ZIP headers without decompressing
  let declaredSize = 0;
  let compressedSize = 0;
  let entryCount = 0;

  try {
    unzipSync(bytes, {
      filter(file) {
        if (!file.name.endsWith("/")) {
          declaredSize += file.originalSize ?? 0;
          compressedSize += file.size ?? 0;
          entryCount += 1;
        }
        return false; // Don't decompress during scan phase
      },
    });
  } catch (error) {
    throw new DecompressionError(
      `Failed to read zip archive: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }

  if (entryCount === 0) {
    throw new DecompressionError("Zip archive contained no files");
  }

  // Guard: Reject if declared uncompressed size exceeds limit
  if (declaredSize > MAX_LOG_SIZE) {
    throw new DecompressionError(
      `logs exceeds maximum size of ${MAX_LOG_SIZE} bytes`
    );
  }

  // Guard: Reject archives with suspicious metadata (possible zip bomb)
  // If declared size < compressed size, headers may be falsified since
  // compression cannot make files larger than their original size
  if (compressedSize > 0 && declaredSize < compressedSize) {
    const worstCaseExpansion = compressedSize * MAX_COMPRESSION_RATIO;
    if (worstCaseExpansion > MAX_LOG_SIZE) {
      throw new DecompressionError(
        `Zip archive may exceed maximum size of ${MAX_LOG_SIZE} bytes`
      );
    }
  }

  // Safe to decompress - headers have been validated
  try {
    const unzipped = unzipSync(bytes);
    const decoder = new TextDecoder();
    const entries = Object.entries(unzipped).filter(
      ([name]) => name && !name.endsWith("/")
    );

    // Post-decompression size check (defense in depth)
    const parts: string[] = [];
    let totalBytes = 0;
    for (const [, data] of entries) {
      totalBytes += data.length;
      if (totalBytes > MAX_LOG_SIZE) {
        throw new DecompressionError(
          `logs exceeds maximum size of ${MAX_LOG_SIZE} bytes`
        );
      }
      parts.push(decoder.decode(data));
    }
    return parts.join("\n");
  } catch (error) {
    if (error instanceof DecompressionError) {
      throw error;
    }
    throw new DecompressionError(
      `Failed to decompress zip archive: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
};
