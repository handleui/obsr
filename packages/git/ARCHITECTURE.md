# Git Package Architecture

Secure git operations for ephemeral clones with process-based locking.

## Module Overview

```
src/
  index.ts       # Package exports
  types.ts       # Branded types, error classes
  utils.ts       # execGit, safeGitEnv, isValidRunID
  validation.ts  # Repository and symlink security checks
  lock.ts        # PID-based lock mechanism
  clone.ts       # Shallow clone creation and management
  cleanup.ts     # Orphan clone garbage collection
  run-id.ts      # Deterministic run ID generation
  operations.ts  # Git command wrappers
```

## Core Concepts

### 1. PID-Based Locking

Inspired by Go's `nightlyone/lockfile`. Each worktree directory contains a `.detent.lock` file with the owning process's PID.

```
/tmp/detent-a1b2c3d4-xyz-1234/
  .detent.lock     # Contains: "12345" (PID)
  .git/
  src/
  ...
```

**Lock Acquisition Flow:**

```
tryAcquireLock(worktreePath)
         |
         v
+------------------+
| Lock file exists?|
+--------+---------+
         |
    Yes  |  No
         v         v
+--------+----+    +------------------+
| Read PID    |    | Create lock file |
+--------+----+    | with O_CREAT |   |
         |         | O_EXCL (atomic)  |
         v         +------------------+
+--------+--------+
| isProcessAlive? |
| (signal 0 trick)|
+--------+--------+
         |
    Yes  |  No
         v         v
     "busy"    Remove stale
               lock, retry
```

**Process Introspection (Signal 0 Trick):**

```typescript
process.kill(pid, 0);  // Signal 0 = existence check, no signal sent
// ESRCH -> process dead (free to reclaim)
// EPERM -> process alive (different user, still valid owner)
// OK    -> process alive (same user)
```

### 2. Symlink Security Validation

Prevents path traversal attacks via malicious symlinks in the repository.

**Validation Limits:**
- `MAX_SYMLINK_DEPTH = 100` (directory traversal depth)
- `MAX_SYMLINKS_CHECKED = 10,000` (total symlinks validated)
- `MAX_CONCURRENT_VALIDATIONS = 20` (parallel directory walks)

**Skipped Directories:** `.git`, `node_modules`, `vendor`, `.venv`

**Resolution Flow:**

```
validateNoEscapingSymlinks(repoRoot)
         |
         v
    Resolve repoRoot to absolute path
         |
         v
+-------------------+
| Walk directory    |
| (concurrent,      |
|  depth-limited)   |
+--------+----------+
         |
         v
+-------------------+
| For each symlink: |
| realpath(target)  |
+--------+----------+
         |
         v
+---------------------------+
| Is target inside repoRoot?|
| relative(repoRoot, target)|
| startsWith("..")?         |
+--------+------------------+
         |
    Yes  |  No
         v         v
  ErrSymlinkEscape  OK
```

### 3. Worktree Lifecycle

Uses shallow clones (`git clone --depth 1`) instead of git worktrees for Docker container compatibility (self-contained `.git` directory).

**Clone Creation:**

```
prepareClone(repoRoot, clonePath)
         |
         +-- Validate commit SHA format (40 hex chars)
         |
         +-- Validate clonePath (no null bytes, length < 4096)
         |
         +-- Validate path security (reject symlinks)
         |
         +-- Check existing clone lock status
         |
         +-- Create directory (mode 0700)
         |
         +-- git clone --depth 1 --no-checkout file://repoRoot clonePath
         |
         +-- git checkout <commitSHA>
         |
         +-- Sync dirty files (uncommitted changes)
         |
         +-- Acquire lock (write PID)
         |
         v
    Return { cloneInfo, cleanup() }
```

**Clone Cleanup:**

```
cleanup()
    |
    +-- Release lock (remove .detent.lock)
    |
    +-- rm -rf clonePath (with timeout: 30s)
```

### 4. Ephemeral Clone Path Strategy

Clone paths are generated in the system temp directory with a deterministic prefix and random suffix for uniqueness.

**Path Format:** `{tmpdir}/detent-{runID}-{timestamp36}-{random8hex}`

**Example:** `/tmp/detent-a1b2c3d4e5f60123-lxyz1234-deadbeef`

**Security Validations:**
- RunID must be hex-only (prevents `../` injection)
- Normalized path must remain within temp directory
- Path depth must be exactly `tmpdir + 1` component

```
createEphemeralClonePath(runID)
         |
         +-- Validate runID (hex chars only, max 64 chars)
         |
         +-- Generate unique suffix (timestamp + random)
         |
         +-- Join: tmpdir + prefix + runID + suffix
         |
         +-- Normalize and verify path stays in tmpdir
         |
         +-- Verify path depth (no nested traversal)
         |
         v
    Return safe path
```

### 5. Safe Git Environment

All git commands run with a restricted environment to prevent config injection and credential leaks.

**Environment Variables:**

| Variable              | Value                | Purpose                         |
|-----------------------|----------------------|---------------------------------|
| GIT_CONFIG_NOSYSTEM   | 1                    | Ignore system-wide gitconfig    |
| GIT_CONFIG_NOGLOBAL   | 1                    | Ignore user-global gitconfig    |
| GIT_TERMINAL_PROMPT   | 0                    | Disable interactive prompts     |
| GIT_ASKPASS           | /bin/true            | No password prompts             |
| GIT_EDITOR            | /bin/true            | No editor invocation            |
| GIT_PAGER             | cat                  | No pager (direct output)        |
| GIT_ATTR_NOSYSTEM     | 1                    | Ignore system gitattributes     |
| GIT_SSH_COMMAND       | ssh -o BatchMode=yes | Non-interactive SSH             |

**Additional Safety:**
- All commands include `-c core.hooksPath=/dev/null` (disable hooks)
- Shell mode disabled (`shell: false`)
- Timeout enforced (default: 30s, max: 50MB buffer)
- Null byte validation on all arguments and paths

**Preserved Variables:** `PATH`, `HOME`, `USER`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `SHELL`, `TERM`

### 6. Orphan Cleanup

Garbage collection for abandoned clones (process died without cleanup).

**Cleanup Criteria:**
1. Directory name starts with `detent-`
2. Located in system temp directory
3. Not a symlink (TOCTOU protection)
4. Lock status is `free` (owner process dead) OR age > 1 hour
5. `.git/config` contains source repo path

```
cleanupOrphanedClones(repoRoot)
         |
         v
    List tempdir entries
         |
         v
    Filter: startsWith("detent-")
         |
         v
+-------------------+
| For each entry:   |
| - Skip symlinks   |
| - Check lock      |
| - Check age       |
| - Verify belongs  |
|   to this repo    |
+--------+----------+
         |
         v
    rm -rf (best effort)
```

## Error Hierarchy

```
Error
  +-- ErrCloneNotInitialized   # Clone not prepared
  +-- ErrNotGitRepository      # Path is not a git repo
  +-- ErrSymlinkEscape         # Symlink points outside repo
  +-- ErrSymlinkLimitExceeded  # Too many symlinks
  +-- ErrSubmodulesNotSupported # .gitmodules present
  +-- ErrInvalidInput          # Bad argument format
  +-- ErrGitTimeout            # Command timeout/killed
```

## Branded Types

TypeScript branded types for compile-time safety:

```typescript
type RunID     = string & { readonly __brand: "RunID" };     // 16-char hex
type CommitSHA = string & { readonly __brand: "CommitSHA" }; // 40-char hex
type TreeHash  = string & { readonly __brand: "TreeHash" };  // 40-char hex
```

## Run ID Computation

Deterministic ID derived from repository state:

```
RunID = SHA256(treeHash + commitSHA)[0:16]
```

Same working tree state always produces the same RunID, enabling caching and deduplication.
