import type { Repo } from "@pierre/storage";
import { GitStorage } from "@pierre/storage";

export interface HealFileChange {
  path: string;
  content: string | null;
}

export interface StoreHealFilesResult {
  repoId: string;
  commitSha: string;
}

const MAX_HEAL_ID_LENGTH = 128;
const MAX_FILE_PATH_LENGTH = 1024;
const MAX_FILE_CONTENT_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_COMMIT = 500;
const MAX_COMMIT_MESSAGE_LENGTH = 4096;
const MAX_CONCURRENT_READS = 10;

// Alphanumeric, hyphens, and underscores only. No dots or slashes to prevent traversal.
const HEAL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Relative paths only: no leading slash, no `..` segments, no null bytes.
const SAFE_PATH_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\0)[a-zA-Z0-9_\-./]+$/;

const assertHealId = (healId: string): void => {
  if (!healId || healId.length > MAX_HEAL_ID_LENGTH) {
    throw new Error(
      `healId must be a non-empty string of at most ${MAX_HEAL_ID_LENGTH} characters`
    );
  }
  if (!HEAL_ID_PATTERN.test(healId)) {
    throw new Error(
      "healId contains invalid characters (only alphanumeric, hyphens, and underscores allowed)"
    );
  }
};

const assertFilePath = (filePath: string): void => {
  if (!filePath || filePath.length > MAX_FILE_PATH_LENGTH) {
    throw new Error(
      `File path must be a non-empty string of at most ${MAX_FILE_PATH_LENGTH} characters`
    );
  }
  if (!SAFE_PATH_PATTERN.test(filePath)) {
    throw new Error(
      `File path "${filePath}" is invalid (must be relative, no ".." segments, no null bytes)`
    );
  }
};

const assertRepoId = (repoId: string): void => {
  if (!repoId?.startsWith("heals/")) {
    throw new Error('repoId must be a non-empty string starting with "heals/"');
  }
  assertHealId(repoId.slice("heals/".length));
};

export const createClient = (name: string, privateKey: string): GitStorage =>
  new GitStorage({ name, key: privateKey });

const assertFileContent = (file: HealFileChange): void => {
  assertFilePath(file.path);
  if (
    file.content !== null &&
    new TextEncoder().encode(file.content).byteLength > MAX_FILE_CONTENT_BYTES
  ) {
    throw new Error(
      `File "${file.path}" exceeds maximum content size of ${MAX_FILE_CONTENT_BYTES} bytes`
    );
  }
};

const assertCommitMessage = (commitMessage: string): void => {
  if (
    !commitMessage ||
    typeof commitMessage !== "string" ||
    commitMessage.length > MAX_COMMIT_MESSAGE_LENGTH
  ) {
    throw new Error(
      `commitMessage must be a non-empty string of at most ${MAX_COMMIT_MESSAGE_LENGTH} characters`
    );
  }
};

const assertFileList = (files: HealFileChange[]): void => {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("files must be a non-empty array");
  }
  if (files.length > MAX_FILES_PER_COMMIT) {
    throw new Error(`files array exceeds maximum of ${MAX_FILES_PER_COMMIT}`);
  }
  for (const file of files) {
    assertFileContent(file);
  }
};

const findOrCreateRepo = async (
  client: GitStorage,
  repoId: string
): Promise<Repo> => {
  const repo = await client.findOne({ id: repoId });
  if (repo) {
    return repo;
  }
  return client.createRepo({ id: repoId });
};

const commitFiles = (
  repo: Repo,
  files: HealFileChange[],
  commitMessage: string
): Promise<{ commitSha: string }> => {
  const commit = repo.createCommit({
    targetBranch: "main",
    commitMessage,
    author: { name: "Detent", email: "heals@detent.sh" },
  });

  for (const file of files) {
    if (file.content !== null) {
      commit.addFileFromString(file.path, file.content);
    } else {
      commit.deletePath(file.path);
    }
  }

  return commit.send();
};

export const storeHealFiles = async (
  client: GitStorage,
  healId: string,
  files: HealFileChange[],
  commitMessage: string
): Promise<StoreHealFilesResult> => {
  assertHealId(healId);
  assertFileList(files);
  assertCommitMessage(commitMessage);

  const repoId = `heals/${healId}`;
  const repo = await findOrCreateRepo(client, repoId);
  const result = await commitFiles(repo, files, commitMessage);

  return { repoId, commitSha: result.commitSha };
};

const readFile = async (repo: Repo, path: string): Promise<HealFileChange> => {
  const response = await repo.getFileStream({ path });
  if (!response.ok) {
    throw new Error(
      `Failed to read file "${path}": ${response.status} ${response.statusText}`
    );
  }
  const content = await response.text();
  return { path, content };
};

const readFilesInBatches = async (
  repo: Repo,
  paths: string[]
): Promise<HealFileChange[]> => {
  if (paths.length <= MAX_CONCURRENT_READS) {
    return Promise.all(paths.map((path) => readFile(repo, path)));
  }

  const results: HealFileChange[] = [];
  for (let i = 0; i < paths.length; i += MAX_CONCURRENT_READS) {
    const batch = paths.slice(i, i + MAX_CONCURRENT_READS);
    const batchResults = await Promise.all(
      batch.map((path) => readFile(repo, path))
    );
    results.push(...batchResults);
  }
  return results;
};

export const readHealFiles = async (
  client: GitStorage,
  repoId: string
): Promise<HealFileChange[]> => {
  assertRepoId(repoId);

  const repo = await client.findOne({ id: repoId });
  if (!repo) {
    return [];
  }

  const { paths } = await repo.listFiles();
  return readFilesInBatches(repo, paths);
};
