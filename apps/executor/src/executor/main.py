"""
Modal app for executing autofix commands.

Deployment: modal deploy src/executor/main.py
Local test: modal run src/executor/main.py::test_autofix
"""
import subprocess
import tempfile
import os
import re
import json
import hashlib
import hmac
from pathlib import Path

import modal

# Modal app and image configuration
app = modal.App("detent-executor")

# SECURITY NOTE: Commands like "bun run fix" and "npm run fix" execute scripts
# defined in the repo's package.json. This is acceptable for trusted repos but
# a malicious repo could define harmful scripts. Consider:
# 1. Only enabling autofix for repos with verified ownership
# 2. Running with network isolation in future versions
# 3. Adding package.json scanning before execution

# Allowlist of safe autofix commands
ALLOWED_COMMANDS = {
    "biome check --write .",
    "biome check --write",
    "biome format --write .",
    "biome format --write",
    "eslint --fix .",
    "eslint --fix",
    "prettier --write .",
    "prettier --write",
    "bun run fix",
    "npm run fix",
    "bun run lint:fix",
    "npm run lint:fix",
}

# Max output sizes to prevent memory issues
MAX_PATCH_SIZE = 1024 * 1024  # 1MB
MAX_COMMAND_OUTPUT = 10000  # 10K chars

# Image with git and common tools
executor_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "curl", "unzip")
    .pip_install("httpx", "fastapi[standard]")
    # Node.js for JS tooling (biome, eslint, prettier)
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
    )
    # Bun for faster npm operations
    .run_commands(
        "curl -fsSL https://bun.sh/install | bash",
        "ln -s /root/.bun/bin/bun /usr/local/bin/bun",
    )
)

# Import httpx only inside Modal container (not available locally)
with executor_image.imports():
    import httpx


def validate_repo_url(url: str) -> bool:
    """Validate GitHub repo URL to prevent SSRF."""
    if not url:
        return False
    # Only allow github.com URLs (with optional token)
    pattern = r'^https://(x-access-token:[^@]+@)?github\.com/[\w\-]+/[\w\-\.]+$'
    return bool(re.match(pattern, url))


def validate_commit_sha(sha: str) -> bool:
    """Validate commit SHA is hexadecimal or allowed branch name."""
    if not sha:
        return False
    # Allow common branch names or hex SHA (7-40 chars)
    if sha in ("main", "master", "develop"):
        return True
    return bool(re.match(r'^[a-f0-9]{7,40}$', sha))


def validate_command(command: str) -> bool:
    """Validate command is in allowlist."""
    return command in ALLOWED_COMMANDS


def sanitize_url_for_logging(url: str) -> str:
    """Remove tokens from URLs before logging."""
    return re.sub(r'x-access-token:[^@]+@', 'x-access-token:***@', url)


def compute_signature(secret: str, payload: str) -> str:
    """Compute HMAC-SHA256 signature for webhook callback."""
    signature = hmac.new(
        secret.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()
    return f"sha256={signature}"


def send_callback(heal_id: str, result: dict):
    """Send result back to Detent API webhook with HMAC signature."""
    api_url = os.environ.get("API_URL", "")
    webhook_secret = os.environ.get("WEBHOOK_SECRET", "")

    if not api_url or not webhook_secret:
        print(f"[executor] Missing API_URL or WEBHOOK_SECRET, skipping callback")
        return

    webhook_url = f"{api_url}/v1/heal/webhook/executor"

    # Prepare payload
    payload = {
        "healId": heal_id,
        "success": result.get("success", False),
        "patch": result.get("patch"),
        "filesChanged": result.get("files_changed"),
        "error": result.get("error"),
    }

    # Remove None values
    payload = {k: v for k, v in payload.items() if v is not None}

    # Compute HMAC signature on the exact JSON we'll send
    # IMPORTANT: We must send the same JSON string we computed the signature on
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    signature = compute_signature(webhook_secret, payload_json)

    try:
        # Send the pre-serialized JSON to ensure signature matches
        response = httpx.post(
            webhook_url,
            content=payload_json,
            headers={
                "Content-Type": "application/json",
                "X-Modal-Signature": signature,
            },
            timeout=30,
        )
        print(f"[executor] Callback sent: {response.status_code}")
    except Exception as e:
        print(f"[executor] Callback failed: {e}")


def execute_autofix(
    heal_id: str,
    repo_url: str,
    commit_sha: str,
    branch: str,
    command: str,
    github_token: str | None,
) -> dict:
    """Execute autofix command and return result."""

    # Inject token into URL for private repos
    if github_token and "github.com" in repo_url:
        repo_url = repo_url.replace(
            "https://github.com",
            f"https://x-access-token:{github_token}@github.com"
        )

    with tempfile.TemporaryDirectory() as tmpdir:
        repo_path = Path(tmpdir) / "repo"

        try:
            # Clone at specific branch
            subprocess.run(
                ["git", "clone", "--depth", "1", "--branch", branch, repo_url, str(repo_path)],
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )

            # Checkout specific commit if different from branch HEAD
            if commit_sha not in ("main", "master", "develop"):
                subprocess.run(
                    ["git", "fetch", "--depth", "1", "origin", commit_sha],
                    cwd=repo_path,
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                subprocess.run(
                    ["git", "checkout", commit_sha],
                    cwd=repo_path,
                    check=True,
                    capture_output=True,
                    text=True,
                )

            # Install dependencies if package.json exists
            if (repo_path / "package.json").exists():
                pkg_manager = "bun" if (repo_path / "bun.lockb").exists() else "npm"
                subprocess.run(
                    [pkg_manager, "install"],
                    cwd=repo_path,
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=120,
                )

            # Run autofix command (validated against allowlist)
            result = subprocess.run(
                command,
                shell=True,
                cwd=repo_path,
                capture_output=True,
                text=True,
                timeout=120,
            )

            # Generate diff
            diff_result = subprocess.run(
                ["git", "diff"],
                cwd=repo_path,
                capture_output=True,
                text=True,
            )

            # Get list of changed files
            files_result = subprocess.run(
                ["git", "diff", "--name-only"],
                cwd=repo_path,
                capture_output=True,
                text=True,
            )

            patch = diff_result.stdout

            # Read actual file contents for each changed file
            files_changed = []
            max_file_size = 1024 * 1024  # 1MB limit per file

            for file_path in files_result.stdout.strip().split("\n"):
                if not file_path:
                    continue

                full_path = repo_path / file_path

                # Handle deleted files (content is null)
                if not full_path.exists():
                    files_changed.append({"path": file_path, "content": None})
                    continue

                # Skip files larger than 1MB
                try:
                    file_size = full_path.stat().st_size
                    if file_size > max_file_size:
                        print(f"[executor] Skipping large file: {file_path} ({file_size} bytes)")
                        continue
                except OSError:
                    continue

                # Try to read file as text, skip binary files
                try:
                    content = full_path.read_text(encoding="utf-8")
                    files_changed.append({"path": file_path, "content": content})
                except UnicodeDecodeError:
                    # Binary file - skip
                    print(f"[executor] Skipping binary file: {file_path}")
                    continue
                except Exception as e:
                    print(f"[executor] Error reading {file_path}: {e}")
                    continue

            # Truncate patch if too large
            if len(patch) > MAX_PATCH_SIZE:
                patch = patch[:MAX_PATCH_SIZE] + f"\n\n[TRUNCATED: patch too large]"

            return {
                "success": True,
                "patch": patch,
                "files_changed": files_changed,
            }

        except subprocess.CalledProcessError as e:
            cmd_str = sanitize_url_for_logging(str(e.cmd))
            return {
                "success": False,
                "error": f"Command failed: {cmd_str}",
            }
        except subprocess.TimeoutExpired as e:
            return {
                "success": False,
                "error": f"Command timed out after {e.timeout} seconds",
            }
        except Exception as e:
            error_msg = sanitize_url_for_logging(str(e))
            return {
                "success": False,
                "error": error_msg,
            }


@app.function(
    image=executor_image,
    timeout=300,
    secrets=[modal.Secret.from_name("detent-api")],
    cpu=2.0,
    memory=2048,
)
def run_autofix_worker(
    heal_id: str,
    repo_url: str,
    commit_sha: str,
    branch: str,
    command: str,
    github_token: str | None,
):
    """Background worker that executes autofix and sends callback."""
    print(f"[executor] Starting autofix for heal {heal_id}")

    result = execute_autofix(heal_id, repo_url, commit_sha, branch, command, github_token)

    print(f"[executor] Autofix completed: success={result.get('success')}")

    # Send result back to API
    send_callback(heal_id, result)

    return result


@app.function(
    image=executor_image,
    secrets=[modal.Secret.from_name("detent-api")],
)
@modal.fastapi_endpoint(method="POST")
def run_autofix(data: dict) -> dict:
    """
    Accept autofix job and spawn worker.

    This endpoint returns immediately after spawning the worker.
    Results are sent back via webhook callback.

    Input:
    {
        "heal_id": "uuid",
        "repo_url": "https://github.com/owner/repo",
        "commit_sha": "abc123",
        "branch": "feature-branch",
        "command": "biome check --write .",
        "github_token": "ghp_xxx"  # For private repos
    }

    Output:
    {
        "accepted": true,
        "heal_id": "uuid"
    }
    """
    heal_id = data.get("heal_id", "")
    repo_url = data.get("repo_url", "")
    commit_sha = data.get("commit_sha", "")
    branch = data.get("branch", "main")
    command = data.get("command", "")
    github_token = data.get("github_token")

    # Validate inputs before spawning
    clean_url = repo_url
    if github_token:
        clean_url = repo_url.replace(f"x-access-token:{github_token}@", "")

    if not validate_repo_url(clean_url):
        return {
            "accepted": False,
            "error": "Invalid repo_url: must be a github.com URL",
        }

    if not validate_commit_sha(commit_sha):
        return {
            "accepted": False,
            "error": "Invalid commit_sha: must be hex or branch name",
        }

    if not validate_command(command):
        return {
            "accepted": False,
            "error": f"Command not allowed. Allowed: {', '.join(sorted(ALLOWED_COMMANDS))}",
        }

    if not heal_id:
        return {
            "accepted": False,
            "error": "heal_id is required",
        }

    # Spawn the worker (fire and forget)
    run_autofix_worker.spawn(
        heal_id=heal_id,
        repo_url=repo_url,
        commit_sha=commit_sha,
        branch=branch,
        command=command,
        github_token=github_token,
    )

    print(f"[executor] Spawned worker for heal {heal_id}")

    return {
        "accepted": True,
        "heal_id": heal_id,
    }


@app.local_entrypoint()
def test_autofix():
    """Test the autofix function locally (synchronous for testing)."""
    result = execute_autofix(
        heal_id="test-123",
        repo_url="https://github.com/modal-labs/modal-examples",
        commit_sha="main",
        branch="main",
        command="biome check --write .",
        github_token=None,
    )
    print(f"Result: {result}")
