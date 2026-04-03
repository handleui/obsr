import { describe, expect, it } from "vitest";
import {
  normalizeBuildObservation,
  normalizeRuntimeObservations,
} from "./normalize";

describe("vercel normalize", () => {
  it("maps failed deployment events to a ci observation", () => {
    const result = normalizeBuildObservation({
      deployment: {
        createdAt: 1_775_184_000_000,
        meta: {
          githubCommitRef: "main",
          githubCommitSha: "abc123",
          githubRepo: "handleui/obsr",
        },
        name: "obsr-web",
        target: "production",
        uid: "dep_1",
        url: "obsr-web.vercel.app",
      },
      events: [
        {
          payload: {
            text: "TypeScript build failed",
          },
        },
      ],
      target: {
        projectId: "prj_1",
        projectName: "obsr-web",
        repo: "handleui/obsr",
        teamId: "team_1",
      },
    });

    expect(result?.sourceKind).toBe("ci");
    expect(result?.dedupeKey).toBe("vercel:build:dep_1");
    expect(result?.context.provider).toBe("vercel");
    expect(result?.context.externalUrl).toBe("https://obsr-web.vercel.app");
  });

  it("groups runtime logs by request id", () => {
    const result = normalizeRuntimeObservations({
      deployment: {
        createdAt: 1_775_184_000_000,
        name: "obsr-web",
        target: "preview",
        uid: "dep_2",
      },
      logs: [
        {
          message: "Unhandled error",
          requestId: "req_1",
          requestPath: "/api/issues",
          rowId: "row_1",
          timestampInMs: 1_775_184_000_000,
        },
        {
          message: "TypeError: cannot read property",
          requestId: "req_1",
          requestPath: "/api/issues",
          rowId: "row_2",
          timestampInMs: 1_775_184_000_100,
        },
      ],
      target: {
        projectId: "prj_1",
        projectName: "obsr-web",
        repo: "handleui/obsr",
        teamId: "team_1",
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.sourceKind).toBe("runtime-log");
    expect(result[0]?.dedupeKey).toBe("vercel:runtime:dep_2:req_1");
    expect(result[0]?.context.route).toBe("/api/issues");
    expect(result[0]?.rawText).toContain("Unhandled error");
  });
});
