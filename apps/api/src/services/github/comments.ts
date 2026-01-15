const GITHUB_API = "https://api.github.com";
const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9._]*$/;

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string; type: string };
  performed_via_github_app: { id: number } | null;
}

const isValidGitHubName = (name: string): boolean => {
  return (
    name.length > 0 &&
    name.length <= 100 &&
    GITHUB_NAME_PATTERN.test(name) &&
    !name.includes("..")
  );
};

const validateOwnerRepo = (
  owner: string,
  repo: string,
  context: string
): void => {
  if (!(isValidGitHubName(owner) && isValidGitHubName(repo))) {
    throw new Error(`${context}: Invalid owner or repo name`);
  }
};

const validateIssueNumber = (issueNumber: number, context: string): void => {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`${context}: Invalid issue number`);
  }
};

const validateCommentId = (commentId: number, context: string): void => {
  if (!Number.isInteger(commentId) || commentId <= 0) {
    throw new Error(`${context}: Invalid comment ID`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const parseIssueComment = (value: unknown, context: string): IssueComment => {
  if (!isRecord(value)) {
    throw new Error(`${context}: Unexpected comment format`);
  }

  const idValue = value.id;
  if (typeof idValue !== "number") {
    throw new Error(`${context}: Comment missing id`);
  }

  const bodyValue = typeof value.body === "string" ? value.body : "";
  const userValue = isRecord(value.user) ? value.user : null;
  const login =
    userValue && typeof userValue.login === "string"
      ? userValue.login
      : "unknown";
  const type =
    userValue && typeof userValue.type === "string" ? userValue.type : "User";

  let performedVia: { id: number } | null = null;
  if (isRecord(value.performed_via_github_app)) {
    const appId = value.performed_via_github_app.id;
    if (typeof appId === "number") {
      performedVia = { id: appId };
    }
  }

  return {
    id: idValue,
    body: bodyValue,
    user: { login, type },
    performed_via_github_app: performedVia,
  };
};

export const listIssueComments = async (
  token: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<IssueComment[]> => {
  const context = `listIssueComments(${owner}/${repo}#${issueNumber})`;

  validateOwnerRepo(owner, repo, context);
  validateIssueNumber(issueNumber, context);

  const perPage = 100;
  let page = 1;
  const comments: IssueComment[] = [];

  while (true) {
    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `${context}: Failed to list issue comments - ${response.status} ${error}`
      );
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error(`${context}: Unexpected response format`);
    }

    for (const item of data) {
      comments.push(parseIssueComment(item, context));
    }

    if (data.length < perPage) {
      break;
    }

    page += 1;
  }

  return comments;
};

export const deleteComment = async (
  token: string,
  owner: string,
  repo: string,
  commentId: number
): Promise<void> => {
  const context = `deleteComment(${owner}/${repo}, commentId=${commentId})`;

  validateOwnerRepo(owner, repo, context);
  validateCommentId(commentId, context);

  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${commentId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Detent-App",
      },
    }
  );

  if (response.status !== 204) {
    const error = await response.text();
    throw new Error(
      `${context}: Failed to delete comment - ${response.status} ${error}`
    );
  }
};
