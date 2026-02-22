import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const LOCK_FILE_NAME = ".detent.lock";

const LOCK_RETRY_ATTEMPTS = 3;
const LOCK_RETRY_DELAY_MS = 100;

export type LockResult =
  | { success: true; release: () => void }
  | { success: false; reason: "busy" | "error"; error?: Error };

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const readLockPid = (lockPath: string): number | undefined => {
  try {
    const content = readFileSync(lockPath, "utf-8").trim();
    const pid = Number.parseInt(content, 10);
    if (Number.isNaN(pid) || pid <= 0) {
      return undefined;
    }
    return pid;
  } catch {
    return undefined;
  }
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Security-critical lock acquisition with proper error handling
export const tryAcquireLock = (worktreePath: string): LockResult => {
  const lockPath = join(worktreePath, LOCK_FILE_NAME);
  const ourPid = process.pid;

  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt++) {
    // Check if lock file exists
    if (existsSync(lockPath)) {
      const existingPid = readLockPid(lockPath);

      if (existingPid !== undefined) {
        // If it's our own PID, we already own it
        if (existingPid === ourPid) {
          return {
            success: true,
            release: () => releaseLock(lockPath),
          };
        }

        // Check if owning process is still alive
        if (isProcessAlive(existingPid)) {
          // Process is alive - lock is busy
          return { success: false, reason: "busy" };
        }

        // Process is dead - remove stale lock
        try {
          unlinkSync(lockPath);
        } catch {
          // If removal fails, retry
          if (attempt < LOCK_RETRY_ATTEMPTS - 1) {
            sleep(LOCK_RETRY_DELAY_MS);
            continue;
          }
          return {
            success: false,
            reason: "error",
            error: new Error("Failed to remove stale lock"),
          };
        }
      } else {
        // Invalid lock file content - remove it
        try {
          unlinkSync(lockPath);
        } catch {
          // Ignore removal errors, try to write anyway
        }
      }
    }

    // Try to create lock file atomically
    try {
      // O_CREAT | O_EXCL ensures atomic creation (fails if file exists)
      const fd = openSync(lockPath, "wx");
      writeSync(fd, String(ourPid));
      closeSync(fd);

      return {
        success: true,
        release: () => releaseLock(lockPath),
      };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EEXIST") {
        // Another process created it first, retry
        if (attempt < LOCK_RETRY_ATTEMPTS - 1) {
          sleep(LOCK_RETRY_DELAY_MS);
          continue;
        }
        return { success: false, reason: "busy" };
      }

      // Other error
      return {
        success: false,
        reason: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  return {
    success: false,
    reason: "error",
    error: new Error("Lock acquisition failed after retries"),
  };
};

const releaseLock = (lockPath: string): void => {
  try {
    unlinkSync(lockPath);
  } catch {
    // Best effort - ignore errors
  }
};

export const checkLockStatus = (
  worktreePath: string
): "free" | "busy" | "error" => {
  const lockPath = join(worktreePath, LOCK_FILE_NAME);

  if (!existsSync(lockPath)) {
    return "free";
  }

  const pid = readLockPid(lockPath);
  if (pid === undefined) {
    // Invalid lock file - treat as free (will be cleaned up on acquire)
    return "free";
  }

  // Our own lock
  if (pid === process.pid) {
    return "free";
  }

  return isProcessAlive(pid) ? "busy" : "free";
};

const sleep = (ms: number): void => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait - only used for short lock retry delays
  }
};
