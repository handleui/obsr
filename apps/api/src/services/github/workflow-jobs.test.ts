import { describe, expect, it } from "vitest";
import type { JobSummary } from "./workflow-jobs";
import { evaluateJobs } from "./workflow-jobs";

const createJob = (overrides: Partial<JobSummary>): JobSummary => ({
  id: 1,
  runId: 100,
  name: "build",
  status: "completed",
  conclusion: "success",
  startedAt: new Date("2025-01-01T00:00:00Z"),
  completedAt: new Date("2025-01-01T00:10:00Z"),
  htmlUrl: "https://github.com/owner/repo/actions/runs/100/job/1",
  workflowName: "CI",
  headBranch: "main",
  runnerName: "ubuntu-latest",
  ...overrides,
});

describe("evaluateJobs", () => {
  it("marks allCompleted true when all jobs are completed", () => {
    const jobs = [
      createJob({ id: 1, status: "completed", conclusion: "success" }),
      createJob({ id: 2, status: "completed", conclusion: "success" }),
    ];

    const result = evaluateJobs(jobs);

    expect(result.allCompleted).toBe(true);
    expect(result.pendingJobs).toEqual([]);
  });

  it("marks allCompleted false when any job is not completed", () => {
    const jobs = [
      createJob({ id: 1, status: "completed", conclusion: "success" }),
      createJob({ id: 2, status: "in_progress", conclusion: null }),
    ];

    const result = evaluateJobs(jobs);

    expect(result.allCompleted).toBe(false);
    expect(result.pendingJobs.map((j) => j.id)).toEqual([2]);
  });

  it("categorizes failed jobs (failure and timed_out)", () => {
    const jobs = [
      createJob({ id: 1, status: "completed", conclusion: "failure" }),
      createJob({ id: 2, status: "completed", conclusion: "timed_out" }),
      createJob({ id: 3, status: "completed", conclusion: "success" }),
    ];

    const result = evaluateJobs(jobs);

    expect(result.failedJobs.map((j) => j.id)).toEqual([1, 2]);
    expect(result.successJobs.map((j) => j.id)).toEqual([3]);
  });

  it("categorizes skipped and cancelled jobs", () => {
    const jobs = [
      createJob({ id: 1, status: "completed", conclusion: "skipped" }),
      createJob({ id: 2, status: "completed", conclusion: "cancelled" }),
    ];

    const result = evaluateJobs(jobs);

    expect(result.skippedJobs.map((j) => j.id)).toEqual([1]);
    expect(result.cancelledJobs.map((j) => j.id)).toEqual([2]);
  });

  it("detects stuck jobs running beyond threshold (30 minutes)", () => {
    const jobs = [
      createJob({
        id: 1,
        status: "in_progress",
        conclusion: null,
        startedAt: new Date("2025-01-01T00:00:00Z"),
      }),
      createJob({
        id: 2,
        status: "in_progress",
        conclusion: null,
        startedAt: new Date("2025-01-01T00:45:00Z"),
      }),
      createJob({
        id: 3,
        status: "queued",
        conclusion: null,
        startedAt: null,
      }),
    ];

    // At 01:00, job 1 has been running 60 min (stuck), job 2 only 15 min (not stuck)
    const result = evaluateJobs(
      jobs,
      new Date("2025-01-01T01:00:00Z").getTime()
    );

    expect(result.stuckJobs.map((j) => j.id)).toEqual([1]);
  });

  it("treats queued jobs as pending but not stuck", () => {
    const jobs = [
      createJob({
        id: 1,
        status: "queued",
        conclusion: null,
        startedAt: null,
      }),
    ];

    const result = evaluateJobs(
      jobs,
      new Date("2025-01-01T01:00:00Z").getTime()
    );

    expect(result.pendingJobs.map((j) => j.id)).toEqual([1]);
    expect(result.stuckJobs).toEqual([]);
  });

  it("handles empty job list", () => {
    const result = evaluateJobs([]);

    expect(result.allCompleted).toBe(true);
    expect(result.jobs).toEqual([]);
    expect(result.pendingJobs).toEqual([]);
    expect(result.failedJobs).toEqual([]);
    expect(result.successJobs).toEqual([]);
  });
});
