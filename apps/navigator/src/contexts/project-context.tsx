"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { ProjectData } from "@/lib/dal";

interface ProjectContextType {
  project: ProjectData;
}

const ProjectContext = createContext<ProjectContextType | null>(null);

interface ProjectProviderProps {
  value: ProjectContextType;
  children: ReactNode;
}

export const ProjectProvider = ({ value, children }: ProjectProviderProps) => (
  <ProjectContext value={value}>{children}</ProjectContext>
);

export const useProject = (): ProjectContextType => {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error("useProject must be used within ProjectProvider");
  }
  return ctx;
};
