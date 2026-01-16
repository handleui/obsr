export const GITHUB_API = "https://api.github.com";

export const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9._]*$/;
export const GITHUB_BRANCH_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9._/]*$/;
export const GIT_SHA_PATTERN = /^[a-fA-F0-9]{7,40}$/;
export const GIT_FULL_SHA_PATTERN = /^[a-fA-F0-9]{40}$/;

export const isValidGitHubName = (name: string): boolean => {
  return (
    name.length > 0 &&
    name.length <= 100 &&
    GITHUB_NAME_PATTERN.test(name) &&
    !name.includes("..")
  );
};

export const isValidBranchName = (branch: string): boolean => {
  return (
    branch.length > 0 &&
    branch.length <= 255 &&
    GITHUB_BRANCH_PATTERN.test(branch) &&
    !branch.includes("..") &&
    !branch.startsWith("/") &&
    !branch.endsWith("/")
  );
};

export const isValidGitSha = (sha: string): boolean => {
  return GIT_SHA_PATTERN.test(sha);
};

export const validateOwnerRepo = (
  owner: string,
  repo: string,
  context: string
): void => {
  if (!(isValidGitHubName(owner) && isValidGitHubName(repo))) {
    throw new Error(`${context}: Invalid owner or repo name`);
  }
};

export const validateGitSha = (sha: string, context: string): void => {
  if (!isValidGitSha(sha)) {
    throw new Error(
      `${context}: Invalid SHA format. Expected 7-40 character hex string`
    );
  }
};

export const validateIssueNumber = (
  issueNumber: number,
  context: string
): void => {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`${context}: Invalid issue number`);
  }
};

export const validateCommentId = (commentId: number, context: string): void => {
  if (!Number.isInteger(commentId) || commentId <= 0) {
    throw new Error(`${context}: Invalid comment ID`);
  }
};
