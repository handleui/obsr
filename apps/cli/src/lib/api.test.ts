import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock, getOrganizationsMock, requestMock, resourceStub } =
  vi.hoisted(() => {
    const request = vi.fn();
    const getOrganizations = vi.fn();
    const stub = {
      list: vi.fn(),
      get: vi.fn(),
      lookup: vi.fn(),
      leave: vi.fn(),
      delete: vi.fn(),
      create: vi.fn(),
      revoke: vi.fn(),
      syncUser: vi.fn(),
      me: vi.fn(),
      getGitHubOrgs: vi.fn(),
      refreshGitHubToken: vi.fn(),
    };

    return {
      createClientMock: vi.fn(() => ({
        request,
        auth: {
          ...stub,
          getOrganizations,
        },
        projects: stub,
        errors: stub,
        members: stub,
        organizations: stub,
        invitations: stub,
      })),
      getOrganizationsMock: getOrganizations,
      requestMock: request,
      resourceStub: stub,
    };
  });

vi.mock("@detent/sdk", () => {
  class DetentAuthError extends Error {}
  class DetentNetworkError extends Error {}

  return {
    createClient: createClientMock,
    DetentAuthError,
    DetentNetworkError,
  };
});

import { apiRequest, getOrganizations } from "./api.js";

describe("cli api auth contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrganizationsMock.mockResolvedValue({ organizations: [] });
    requestMock.mockResolvedValue({ ok: true });

    resourceStub.list.mockResolvedValue([]);
    resourceStub.get.mockResolvedValue(null);
    resourceStub.lookup.mockResolvedValue(null);
    resourceStub.leave.mockResolvedValue({ success: true });
    resourceStub.delete.mockResolvedValue({ success: true });
    resourceStub.create.mockResolvedValue({ id: "invitation-1" });
    resourceStub.revoke.mockResolvedValue({ success: true });
    resourceStub.syncUser.mockResolvedValue({ user_id: "user-1" });
    resourceStub.me.mockResolvedValue({ user_id: "user-1" });
    resourceStub.getGitHubOrgs.mockResolvedValue({ orgs: [] });
    resourceStub.refreshGitHubToken.mockResolvedValue({
      access_token: "token",
      expires_in: 3600,
      token_type: "bearer",
    });
  });

  it("creates sdk client with jwt auth for organization calls", async () => {
    await getOrganizations("cli-session-token");

    expect(createClientMock).toHaveBeenCalledWith({
      baseUrl: expect.any(String),
      auth: {
        type: "jwt",
        token: "cli-session-token",
      },
    });
  });

  it("creates sdk client with jwt auth for generic requests", async () => {
    await apiRequest("/v1/projects", {
      method: "GET",
      accessToken: "cli-session-token",
    });

    expect(createClientMock).toHaveBeenCalledWith({
      baseUrl: expect.any(String),
      auth: {
        type: "jwt",
        token: "cli-session-token",
      },
    });
  });
});
