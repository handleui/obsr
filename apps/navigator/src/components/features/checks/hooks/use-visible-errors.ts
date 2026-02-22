"use client";

import { useMemo } from "react";
import { useFilters } from "./use-filters";
import { useRunData } from "./use-run-data";

export const useVisibleErrors = () => {
  const { jobs: jobRegistry, errors } = useRunData();
  const { jobs, statuses } = useFilters();

  return useMemo(() => {
    const visibleJobs = new Set(
      jobRegistry
        .filter((j) => jobs.has(j.key) && statuses.has(j.status))
        .map((j) => j.key)
    );
    return errors.filter((e) => visibleJobs.has(e.jobKey));
  }, [jobs, statuses, jobRegistry, errors]);
};
