"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { ErrorDetailData, JobMeta, MockRun } from "./mock-data";

interface RunDataContextValue {
  run: MockRun;
  errors: ErrorDetailData[];
  errorMap: Map<string, ErrorDetailData>;
  jobs: JobMeta[];
}

const RunDataContext = createContext<RunDataContextValue | null>(null);

export const useRunData = () => {
  const ctx = useContext(RunDataContext);
  if (!ctx) {
    throw new Error("useRunData must be used within RunDataProvider");
  }
  return ctx;
};

interface RunDataProviderProps {
  run: MockRun;
  children: ReactNode;
}

export const RunDataProvider = ({ run, children }: RunDataProviderProps) => {
  const value = useMemo(() => {
    const errorMap = new Map(run.errors.map((e) => [e.id, e]));
    return {
      run,
      errors: run.errors,
      errorMap,
      jobs: run.jobs,
    };
  }, [run]);

  return <RunDataContext value={value}>{children}</RunDataContext>;
};
