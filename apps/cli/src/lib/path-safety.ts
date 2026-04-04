import { relative, resolve, sep } from "node:path";

function isResolvedInsideBase(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  if (rel === "") {
    return true;
  }
  if (rel === "..") {
    return false;
  }
  return !rel.startsWith(`..${sep}`);
}

export function resolvePathUnderCwd(cwd: string, userSegment: string): string {
  const resolved = resolve(cwd, userSegment);
  if (!isResolvedInsideBase(cwd, resolved)) {
    throw new Error(
      `Path escapes working directory: ${userSegment}. Use a path inside the current directory.`
    );
  }
  return resolved;
}

export function assertComposeFileAllowed(
  cwd: string,
  composePath: string,
  allowOutside: boolean
): void {
  if (allowOutside) {
    return;
  }
  if (!isResolvedInsideBase(cwd, composePath)) {
    throw new Error(
      "Compose file is outside the working directory. Run from the project root, use a relative path, or pass --allow-outside."
    );
  }
}
