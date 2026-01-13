/**
 * Shared error handlers for CLI commands
 */

/**
 * Handle errors when fetching GitHub organizations
 * Provides user-friendly error messages for common GitHub-related issues
 */
export const handleGitHubOrgError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("GitHub account not connected")) {
    console.error("GitHub account not connected.");
    console.error(
      "Please authenticate with GitHub: run `dt auth login --force`"
    );
  } else if (
    message.includes("authorization expired") ||
    message.includes("GitHub token expired")
  ) {
    console.error("GitHub authorization expired.");
    console.error("Please re-authenticate: run `dt auth login --force`");
  } else if (message.includes("GitHub token required")) {
    console.error("GitHub authentication required for this operation.");
    console.error("Please re-authenticate: run `dt auth login --force`");
  } else {
    console.error("Failed to fetch GitHub organizations:", message);
  }
  process.exit(1);
};
