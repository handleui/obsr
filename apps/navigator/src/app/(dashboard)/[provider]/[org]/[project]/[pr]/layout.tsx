import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { FilterProvider } from "@/components/features/checks/hooks/use-filters";
import { NavigationProvider } from "@/components/features/checks/hooks/use-navigation";
import { RunDataProvider } from "@/components/features/checks/hooks/use-run-data";
import { SelectionProvider } from "@/components/features/checks/hooks/use-selection";
import type { RunData } from "@/components/features/checks/lib/types";
import { fetchProject } from "@/lib/dal";

const ALLOWED_PROVIDERS = new Set(["gh", "gl"]);
const MAX_PR_NUMBER = 2_147_483_647;

interface PrParams {
  provider: string;
  org: string;
  project: string;
  pr: string;
}

interface PrLayoutProps {
  children: ReactNode;
  params: Promise<PrParams>;
}

const validateParams = ({ provider, org, project, pr }: PrParams) => {
  if (!ALLOWED_PROVIDERS.has(provider)) {
    notFound();
  }
  if (org.length > 255 || project.length > 255 || pr.length > 10) {
    notFound();
  }

  const prNumber = Number.parseInt(pr, 10);
  if (Number.isNaN(prNumber) || prNumber <= 0 || prNumber > MAX_PR_NUMBER) {
    notFound();
  }

  return prNumber;
};

const buildRunData = (
  org: string,
  prNumber: number,
  projectData: { handle: string; provider_default_branch?: string | null }
): RunData => ({
  org: org.toLowerCase(),
  project: projectData.handle,
  pr: String(prNumber),
  title: `PR #${prNumber}`,
  author: "Unknown",
  branch: {
    source: "feature",
    target: projectData.provider_default_branch ?? "main",
  },
  files: 0,
  additions: 0,
  deletions: 0,
  description: "",
  jobs: [],
  errors: [],
});

const PrLayout = async ({ children, params }: PrLayoutProps) => {
  const { provider, org, project, pr } = await params;
  const prNumber = validateParams({ provider, org, project, pr });

  const projectData = await fetchProject(provider, org, project);
  if (!projectData) {
    notFound();
  }

  const basePath = `/${encodeURIComponent(provider)}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/${encodeURIComponent(pr)}`;
  const run = buildRunData(org, prNumber, projectData);

  return (
    <RunDataProvider run={run}>
      <NavigationProvider basePath={basePath}>
        <SelectionProvider>
          <FilterProvider jobs={run.jobs.map((j) => j.key)}>
            <div className="flex h-screen overflow-hidden">{children}</div>
          </FilterProvider>
        </SelectionProvider>
      </NavigationProvider>
    </RunDataProvider>
  );
};

export default PrLayout;
