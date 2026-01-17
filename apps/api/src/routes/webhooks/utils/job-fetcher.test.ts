import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobEvaluation } from "../../../services/github/workflow-jobs";
import type { WorkflowRunEvaluation } from "../../../services/github/workflow-runs";
import { fetchJobDetailsWithRateLimit } from "./job-fetcher";

// Mock the rate-limit module
const mockHasRateLimitHeadroom = vi.fn<() => boolean>();

vi.mock("../../../services/github/rate-limit", () => ({
  hasRateLimitHeadroom: () => mockHasRateLimitHeadroom(),
}));

const createMockJobEvaluation = (runId: number): JobEvaluation => ({
  allCompleted: false,
  jobs: [
    {
      id: runId * 100,
      runId,
      name: `job-${runId}`,
      status: "in_progress",
      conclusion: null,
      startedAt: new Date(),
      completedAt: null,
      htmlUrl: null,
      workflowName: "CI",
      headBranch: "main",
      runnerName: "ubuntu-latest",
    },
  ],
  pendingJobs: [],
  failedJobs: [],
  successJobs: [],
  skippedJobs: [],
  cancelledJobs: [],
  stuckJobs: [],
});

const createMockEvaluation = (
  pendingRunIds: number[]
): WorkflowRunEvaluation => ({
  allCompleted: false,
  ciRelevantRuns: pendingRunIds.map((id) => ({
    id,
    name: `workflow-${id}`,
    status: "in_progress",
    conclusion: null,
    headBranch: "main",
    runAttempt: 1,
    runStartedAt: new Date(),
    event: "pull_request",
  })),
  pendingCiRuns: pendingRunIds.map((id) => ({
    id,
    name: `workflow-${id}`,
    status: "in_progress",
    conclusion: null,
    headBranch: "main",
    runAttempt: 1,
    runStartedAt: new Date(),
    event: "pull_request",
  })),
  skippedRuns: [],
  stuckRuns: [],
  blacklistedRuns: [],
  nonBlacklistedRuns: [],
});

describe("fetchJobDetailsWithRateLimit", () => {
  // Use vi.fn() directly and cast to never when passing to the function
  const mockListJobsForWorkflowRun = vi.fn();

  const mockGithub = {
    listJobsForWorkflowRun: mockListJobsForWorkflowRun,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockHasRateLimitHeadroom.mockReturnValue(true);
  });

  it("returns empty map when rate limit is low", async () => {
    mockHasRateLimitHeadroom.mockReturnValue(false);
    const evaluation = createMockEvaluation([1, 2]);

    const result = await fetchJobDetailsWithRateLimit(
      mockGithub as never,
      "token",
      "owner",
      "repo",
      evaluation,
      "test"
    );

    expect(result.size).toBe(0);
    expect(mockListJobsForWorkflowRun).not.toHaveBeenCalled();
  });

  it("fetches jobs for pending runs when rate limit is available", async () => {
    const evaluation = createMockEvaluation([1]);
    mockListJobsForWorkflowRun.mockResolvedValue({
      evaluation: createMockJobEvaluation(1),
    });

    const result = await fetchJobDetailsWithRateLimit(
      mockGithub as never,
      "token",
      "owner",
      "repo",
      evaluation,
      "test"
    );

    expect(result.size).toBe(1);
    expect(result.has(1)).toBe(true);
    expect(mockListJobsForWorkflowRun).toHaveBeenCalledWith(
      "token",
      "owner",
      "repo",
      1
    );
  });

  it("limits fetches to MAX_WORKFLOWS_FOR_JOB_FETCH (2)", async () => {
    const evaluation = createMockEvaluation([1, 2, 3, 4]);
    mockListJobsForWorkflowRun.mockImplementation(
      async (_token: string, _owner: string, _repo: string, runId: number) => ({
        evaluation: createMockJobEvaluation(runId),
      })
    );

    const result = await fetchJobDetailsWithRateLimit(
      mockGithub as never,
      "token",
      "owner",
      "repo",
      evaluation,
      "test"
    );

    // Should only fetch first 2 workflows
    expect(result.size).toBe(2);
    expect(result.has(1)).toBe(true);
    expect(result.has(2)).toBe(true);
    expect(result.has(3)).toBe(false);
    expect(result.has(4)).toBe(false);
    expect(mockListJobsForWorkflowRun).toHaveBeenCalledTimes(2);
  });

  it("handles fetch errors gracefully without failing", async () => {
    const evaluation = createMockEvaluation([1, 2]);
    mockListJobsForWorkflowRun
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce({ evaluation: createMockJobEvaluation(2) });

    const result = await fetchJobDetailsWithRateLimit(
      mockGithub as never,
      "token",
      "owner",
      "repo",
      evaluation,
      "test"
    );

    // Should still have result for run 2 even though run 1 failed
    expect(result.size).toBe(1);
    expect(result.has(1)).toBe(false);
    expect(result.has(2)).toBe(true);
  });

  it("returns empty map when no pending runs", async () => {
    const evaluation = createMockEvaluation([]);

    const result = await fetchJobDetailsWithRateLimit(
      mockGithub as never,
      "token",
      "owner",
      "repo",
      evaluation,
      "test"
    );

    expect(result.size).toBe(0);
    expect(mockListJobsForWorkflowRun).not.toHaveBeenCalled();
  });

  it("fetches runs sequentially (not in parallel)", async () => {
    const callOrder: number[] = [];
    const evaluation = createMockEvaluation([1, 2]);

    mockListJobsForWorkflowRun.mockImplementation(
      async (_token: string, _owner: string, _repo: string, runId: number) => {
        callOrder.push(runId);
        // Small delay to verify sequential execution
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { evaluation: createMockJobEvaluation(runId) };
      }
    );

    await fetchJobDetailsWithRateLimit(
      mockGithub as never,
      "token",
      "owner",
      "repo",
      evaluation,
      "test"
    );

    // Verify calls were made in order (sequential)
    expect(callOrder).toEqual([1, 2]);
  });
});
