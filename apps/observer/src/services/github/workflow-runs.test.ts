import { describe, expect, it } from "vitest";
import type { WorkflowRunSummary } from "./workflow-runs";
import { evaluateWorkflowRuns } from "./workflow-runs";

const createRun = (
  overrides: Partial<WorkflowRunSummary>
): WorkflowRunSummary => ({
  id: 1,
  name: "CI",
  status: "completed",
  conclusion: "success",
  headBranch: "main",
  runAttempt: 1,
  runStartedAt: new Date("2025-01-01T00:00:00Z"),
  event: "pull_request",
  ...overrides,
});

describe("evaluateWorkflowRuns", () => {
  it("separates blacklisted runs and excludes them from CI evaluation", () => {
    const runs = [
      createRun({ id: 1, name: "Render.com Deploy", event: "push" }),
      createRun({ id: 2, name: "CI", event: "pull_request" }),
    ];

    const result = evaluateWorkflowRuns(
      runs,
      new Date("2025-01-01T01:00:00Z").getTime()
    );

    expect(result.blacklistedRuns.map((run) => run.id)).toEqual([1]);
    expect(result.nonBlacklistedRuns.map((run) => run.id)).toEqual([2]);
    expect(result.ciRelevantRuns.map((run) => run.id)).toEqual([2]);
  });

  it("filters CI-relevant events from skipped runs", () => {
    const runs = [
      createRun({ id: 1, event: "push" }),
      createRun({ id: 2, event: "schedule" }),
      createRun({ id: 3, event: "workflow_dispatch" }),
    ];

    const result = evaluateWorkflowRuns(
      runs,
      new Date("2025-01-01T01:00:00Z").getTime()
    );

    expect(result.ciRelevantRuns.map((run) => run.id)).toEqual([1]);
    expect(result.skippedRuns.map((run) => run.id)).toEqual([2, 3]);
  });

  it("marks allCompleted false when any CI run is not completed", () => {
    const runs = [
      createRun({ id: 1, event: "push", status: "completed" }),
      createRun({ id: 2, event: "pull_request", status: "in_progress" }),
    ];

    const result = evaluateWorkflowRuns(
      runs,
      new Date("2025-01-01T01:00:00Z").getTime()
    );

    expect(result.allCompleted).toBe(false);
    expect(result.pendingCiRuns.map((run) => run.id)).toEqual([2]);
  });

  it("treats no CI-relevant runs as completed", () => {
    const runs = [createRun({ id: 1, event: "schedule" })];

    const result = evaluateWorkflowRuns(
      runs,
      new Date("2025-01-01T01:00:00Z").getTime()
    );

    expect(result.allCompleted).toBe(true);
    expect(result.pendingCiRuns).toEqual([]);
  });

  it("detects stuck runs beyond the threshold", () => {
    const runs = [
      createRun({
        id: 1,
        status: "in_progress",
        runStartedAt: new Date("2025-01-01T00:00:00Z"),
      }),
      createRun({
        id: 2,
        status: "in_progress",
        runStartedAt: new Date("2025-01-01T00:45:00Z"),
      }),
      createRun({ id: 3, status: "queued", runStartedAt: null }),
    ];

    const result = evaluateWorkflowRuns(
      runs,
      new Date("2025-01-01T01:00:00Z").getTime()
    );

    expect(result.stuckRuns.map((run) => run.id)).toEqual([1]);
  });
});
