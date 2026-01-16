import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../../lib/config.js";

// Mock external dependencies
vi.mock("@detent/git", () => ({
  findGitRoot: vi.fn(),
  getRemoteUrl: vi.fn(),
}));

vi.mock("../../lib/auth.js", () => ({
  getAccessToken: vi.fn(),
}));

vi.mock("../../lib/api.js", () => ({
  getOrganizations: vi.fn(),
  lookupProject: vi.fn(),
}));

vi.mock("../../lib/config.js", () => ({
  getProjectConfig: vi.fn(),
  saveProjectConfig: vi.fn(),
  removeProjectConfig: vi.fn(),
}));

vi.mock("../../lib/git-utils.js", () => ({
  parseRemoteUrl: vi.fn(),
}));

vi.mock("../../tui/styles.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    printOrgProjectTable: vi.fn(),
  };
});

const createMockProjectConfig = (
  overrides: Partial<ProjectConfig> = {}
): ProjectConfig => ({
  organizationId: "org-123",
  organizationSlug: "test-org",
  projectId: "proj-123",
  projectHandle: "test-repo",
  ...overrides,
});

// Custom error to simulate process.exit
class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

describe("link commands", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    consoleLogSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new ExitError(code as number);
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    processExitSpy.mockRestore();
    vi.clearAllMocks();
  });

  describe("link command (index)", () => {
    it("exits if not in git repository", async () => {
      const { findGitRoot } = await import("@detent/git");
      vi.mocked(findGitRoot).mockResolvedValue(null);

      const { linkCommand } = await import("./index.js");

      await expect(
        linkCommand.run?.({ args: { force: false } })
      ).rejects.toThrow(ExitError);
      expect(consoleErrorSpy).toHaveBeenCalledWith("Not in a git repository.");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("exits if not logged in", async () => {
      const { findGitRoot } = await import("@detent/git");
      const { getAccessToken } = await import("../../lib/auth.js");
      const { getProjectConfig } = await import("../../lib/config.js");

      vi.mocked(findGitRoot).mockResolvedValue("/repo");
      vi.mocked(getProjectConfig).mockReturnValue(null);
      vi.mocked(getAccessToken).mockRejectedValue(new Error("Not logged in"));

      const { linkCommand } = await import("./index.js");

      await expect(
        linkCommand.run?.({ args: { force: false } })
      ).rejects.toThrow(ExitError);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Not logged in. Run `dt auth login` first."
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("shows already linked message if repo is linked without force flag", async () => {
      const { findGitRoot } = await import("@detent/git");
      const { getAccessToken } = await import("../../lib/auth.js");
      const { getProjectConfig } = await import("../../lib/config.js");

      const existingConfig = createMockProjectConfig();

      vi.mocked(findGitRoot).mockResolvedValue("/repo");
      vi.mocked(getAccessToken).mockResolvedValue("token-123");
      vi.mocked(getProjectConfig).mockReturnValue(existingConfig);

      const { linkCommand } = await import("./index.js");
      await linkCommand.run?.({ args: { force: false } });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        "Already linked. Run `dt link --force` to relink."
      );
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("exits if no git remote", async () => {
      const { findGitRoot, getRemoteUrl } = await import("@detent/git");
      const { getAccessToken } = await import("../../lib/auth.js");
      const { getProjectConfig } = await import("../../lib/config.js");

      vi.mocked(findGitRoot).mockResolvedValue("/repo");
      vi.mocked(getProjectConfig).mockReturnValue(null);
      vi.mocked(getAccessToken).mockResolvedValue("token-123");
      vi.mocked(getRemoteUrl).mockResolvedValue(null);

      const { linkCommand } = await import("./index.js");

      await expect(
        linkCommand.run?.({ args: { force: false } })
      ).rejects.toThrow(ExitError);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "No git remote 'origin' found."
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("exits if git remote URL cannot be parsed", async () => {
      const { findGitRoot, getRemoteUrl } = await import("@detent/git");
      const { getAccessToken } = await import("../../lib/auth.js");
      const { getProjectConfig } = await import("../../lib/config.js");
      const { parseRemoteUrl } = await import("../../lib/git-utils.js");

      vi.mocked(findGitRoot).mockResolvedValue("/repo");
      vi.mocked(getProjectConfig).mockReturnValue(null);
      vi.mocked(getAccessToken).mockResolvedValue("token-123");
      vi.mocked(getRemoteUrl).mockResolvedValue("invalid-url");
      vi.mocked(parseRemoteUrl).mockReturnValue(null);

      const { linkCommand } = await import("./index.js");

      await expect(
        linkCommand.run?.({ args: { force: false } })
      ).rejects.toThrow(ExitError);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Could not parse git remote URL: invalid-url"
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("links successfully when project exists", async () => {
      const { findGitRoot, getRemoteUrl } = await import("@detent/git");
      const { getAccessToken } = await import("../../lib/auth.js");
      const { getProjectConfig, saveProjectConfig } = await import(
        "../../lib/config.js"
      );
      const { parseRemoteUrl } = await import("../../lib/git-utils.js");
      const { lookupProject } = await import("../../lib/api.js");

      vi.mocked(findGitRoot).mockResolvedValue("/repo");
      vi.mocked(getProjectConfig).mockReturnValue(null);
      vi.mocked(getAccessToken).mockResolvedValue("token-123");
      vi.mocked(getRemoteUrl).mockResolvedValue(
        "git@github.com:test-org/test-repo.git"
      );
      vi.mocked(parseRemoteUrl).mockReturnValue("test-org/test-repo");
      vi.mocked(lookupProject).mockResolvedValue({
        project_id: "proj-123",
        organization_id: "org-123",
        organization_name: "Test Org",
        organization_slug: "test-org",
        handle: "test-repo",
        provider_repo_id: "123",
        provider_repo_name: "test-repo",
        provider_repo_full_name: "test-org/test-repo",
        provider_default_branch: "main",
        is_private: false,
        created_at: new Date().toISOString(),
      });

      const { linkCommand } = await import("./index.js");
      await linkCommand.run?.({ args: { force: false } });

      expect(saveProjectConfig).toHaveBeenCalledWith("/repo", {
        organizationId: "org-123",
        organizationSlug: "test-org",
        projectId: "proj-123",
        projectHandle: "test-repo",
      });
      expect(consoleLogSpy).toHaveBeenCalledWith("Linked successfully.");
    });

    it("exits when project does not exist", async () => {
      const { findGitRoot, getRemoteUrl } = await import("@detent/git");
      const { getAccessToken } = await import("../../lib/auth.js");
      const { getProjectConfig } = await import("../../lib/config.js");
      const { parseRemoteUrl } = await import("../../lib/git-utils.js");
      const { lookupProject } = await import("../../lib/api.js");

      vi.mocked(findGitRoot).mockResolvedValue("/repo");
      vi.mocked(getProjectConfig).mockReturnValue(null);
      vi.mocked(getAccessToken).mockResolvedValue("token-123");
      vi.mocked(getRemoteUrl).mockResolvedValue(
        "git@github.com:unknown-org/unknown-repo.git"
      );
      vi.mocked(parseRemoteUrl).mockReturnValue("unknown-org/unknown-repo");
      vi.mocked(lookupProject).mockRejectedValue(new Error("Not found"));

      const { linkCommand } = await import("./index.js");

      await expect(
        linkCommand.run?.({ args: { force: false } })
      ).rejects.toThrow(ExitError);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "\nCould not link repository."
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "\nProject 'unknown-org/unknown-repo' is not registered in Detent."
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("allows relinking with --force flag", async () => {
      const { findGitRoot, getRemoteUrl } = await import("@detent/git");
      const { getAccessToken } = await import("../../lib/auth.js");
      const { getProjectConfig, saveProjectConfig } = await import(
        "../../lib/config.js"
      );
      const { parseRemoteUrl } = await import("../../lib/git-utils.js");
      const { lookupProject } = await import("../../lib/api.js");

      const existingConfig = createMockProjectConfig({
        organizationId: "org-old",
        organizationSlug: "old-org",
        projectId: "proj-old",
        projectHandle: "old-repo",
      });

      vi.mocked(findGitRoot).mockResolvedValue("/repo");
      vi.mocked(getProjectConfig).mockReturnValue(existingConfig);
      vi.mocked(getAccessToken).mockResolvedValue("token-123");
      vi.mocked(getRemoteUrl).mockResolvedValue(
        "git@github.com:new-org/new-repo.git"
      );
      vi.mocked(parseRemoteUrl).mockReturnValue("new-org/new-repo");
      vi.mocked(lookupProject).mockResolvedValue({
        project_id: "proj-new",
        organization_id: "org-new",
        organization_name: "New Organization",
        organization_slug: "new-org",
        handle: "new-repo",
        provider_repo_id: "456",
        provider_repo_name: "new-repo",
        provider_repo_full_name: "new-org/new-repo",
        provider_default_branch: "main",
        is_private: false,
        created_at: new Date().toISOString(),
      });

      const { linkCommand } = await import("./index.js");
      await linkCommand.run?.({ args: { force: true } });

      expect(saveProjectConfig).toHaveBeenCalledWith("/repo", {
        organizationId: "org-new",
        organizationSlug: "new-org",
        projectId: "proj-new",
        projectHandle: "new-repo",
      });
    });

    it("has correct meta information", async () => {
      const { linkCommand } = await import("./index.js");

      expect(linkCommand.meta?.name).toBe("link");
      expect(linkCommand.meta?.description).toBe(
        "Link this repository to a Detent project"
      );
    });

    it("has status subcommand", async () => {
      const { linkCommand } = await import("./index.js");

      expect(linkCommand.subCommands).toBeDefined();
      expect(linkCommand.subCommands?.status).toBeDefined();
    });

    it("has unlink subcommand", async () => {
      const { linkCommand } = await import("./index.js");

      expect(linkCommand.subCommands).toBeDefined();
      expect(linkCommand.subCommands?.unlink).toBeDefined();
    });
  });

  describe("status command", () => {
    it("exits if not in git repository", async () => {
      const { findGitRoot } = await import("@detent/git");
      vi.mocked(findGitRoot).mockResolvedValue(null);

      const { statusCommand } = await import("./status.js");

      await expect(statusCommand.run?.({ args: {} })).rejects.toThrow(
        ExitError
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith("Not in a git repository.");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("shows not linked message if repo is not linked", async () => {
      const { findGitRoot } = await import("@detent/git");
      const { getProjectConfig } = await import("../../lib/config.js");

      vi.mocked(findGitRoot).mockResolvedValue("/repo");
      vi.mocked(getProjectConfig).mockReturnValue(null);

      const { statusCommand } = await import("./status.js");
      await statusCommand.run?.({ args: {} });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        "This repository is not linked."
      );
    });

    it("shows project path when repo is linked", async () => {
      const { findGitRoot } = await import("@detent/git");
      const { getProjectConfig } = await import("../../lib/config.js");
      const { printOrgProjectTable } = await import("../../tui/styles.js");

      const projectConfig = createMockProjectConfig();

      vi.mocked(findGitRoot).mockResolvedValue("/repo");
      vi.mocked(getProjectConfig).mockReturnValue(projectConfig);

      const { statusCommand } = await import("./status.js");
      await statusCommand.run?.({ args: {} });

      expect(printOrgProjectTable).toHaveBeenCalledWith(
        "test-org",
        "test-repo"
      );
    });
  });

  describe("unlink command", () => {
    it("exits if not in git repository", async () => {
      const { findGitRoot } = await import("@detent/git");
      vi.mocked(findGitRoot).mockResolvedValue(null);

      const { unlinkCommand } = await import("./unlink.js");

      await expect(
        unlinkCommand.run?.({ args: { force: false } })
      ).rejects.toThrow(ExitError);
      expect(consoleErrorSpy).toHaveBeenCalledWith("Not in a git repository.");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("shows not linked message if repo is not linked", async () => {
      const { findGitRoot } = await import("@detent/git");
      const { getProjectConfig } = await import("../../lib/config.js");

      vi.mocked(findGitRoot).mockResolvedValue("/repo");
      vi.mocked(getProjectConfig).mockReturnValue(null);

      const { unlinkCommand } = await import("./unlink.js");
      await unlinkCommand.run?.({ args: { force: false } });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        "This repository is not linked."
      );
    });

    it("removes project config with --force flag", async () => {
      const { findGitRoot } = await import("@detent/git");
      const { getProjectConfig, removeProjectConfig } = await import(
        "../../lib/config.js"
      );

      const projectConfig = createMockProjectConfig();

      vi.mocked(findGitRoot).mockResolvedValue("/repo");
      vi.mocked(getProjectConfig).mockReturnValue(projectConfig);

      const { unlinkCommand } = await import("./unlink.js");
      await unlinkCommand.run?.({ args: { force: true } });

      expect(removeProjectConfig).toHaveBeenCalledWith("/repo");
      expect(consoleLogSpy).toHaveBeenCalledWith("Unlinked successfully.");
    });
  });
});
