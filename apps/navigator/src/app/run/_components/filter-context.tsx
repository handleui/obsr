"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { soloInSet, toggleInSet } from "./set-utils";

interface FilterContextValue {
  jobs: Set<string>;
  statuses: Set<string>;
  toggleJob: (value: string) => void;
  toggleStatus: (value: string) => void;
  soloJob: (value: string) => void;
  soloStatus: (value: string) => void;
  resetJobs: () => void;
  resetStatuses: () => void;
}

const FilterContext = createContext<FilterContextValue | null>(null);

export const useFilters = () => {
  const ctx = useContext(FilterContext);
  if (!ctx) {
    throw new Error("useFilters must be used within FilterProvider");
  }
  return ctx;
};

const ALL_JOBS = ["lint", "test", "check-types", "migrations", "build"];
const ALL_STATUSES = [
  "failed",
  "waiting",
  "successful",
  "healed",
  "healing",
  "skipped",
];

export const FilterProvider = ({ children }: { children: ReactNode }) => {
  const [jobs, setJobs] = useState(() => new Set(ALL_JOBS));
  const [statuses, setStatuses] = useState(() => new Set(ALL_STATUSES));

  const toggleJob = useCallback(
    (value: string) => setJobs((prev) => toggleInSet(prev, value)),
    []
  );

  const toggleStatus = useCallback(
    (value: string) => setStatuses((prev) => toggleInSet(prev, value)),
    []
  );

  const soloJob = useCallback(
    (value: string) => setJobs((prev) => soloInSet(prev, value, ALL_JOBS)),
    []
  );

  const soloStatus = useCallback(
    (value: string) =>
      setStatuses((prev) => soloInSet(prev, value, ALL_STATUSES)),
    []
  );

  const resetJobs = useCallback(() => setJobs(new Set(ALL_JOBS)), []);
  const resetStatuses = useCallback(
    () => setStatuses(new Set(ALL_STATUSES)),
    []
  );

  const value = useMemo(
    () => ({
      jobs,
      statuses,
      toggleJob,
      toggleStatus,
      soloJob,
      soloStatus,
      resetJobs,
      resetStatuses,
    }),
    [
      jobs,
      statuses,
      toggleJob,
      toggleStatus,
      soloJob,
      soloStatus,
      resetJobs,
      resetStatuses,
    ]
  );

  return <FilterContext value={value}>{children}</FilterContext>;
};
