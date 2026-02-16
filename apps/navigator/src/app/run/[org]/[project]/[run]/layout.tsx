import type { ReactNode } from "react";
import { FilterProvider } from "../../../_components/filter-context";
import { getMockRun } from "../../../_components/mock-data";
import { NavigationProvider } from "../../../_components/navigation/navigation-context";
import { RunDataProvider } from "../../../_components/run-data-context";
import { SelectionProvider } from "../../../_components/selection-context";

interface RunLayoutProps {
  children: ReactNode;
  params: Promise<{ org: string; project: string; run: string }>;
}

const RunLayout = async ({ children, params }: RunLayoutProps) => {
  const { org, project, run } = await params;
  const basePath = `/${org}/${project}/${run}`;
  const mockRun = getMockRun(org, project);

  if (!mockRun) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted">Run not found</p>
      </div>
    );
  }

  return (
    <RunDataProvider run={mockRun}>
      <NavigationProvider basePath={basePath}>
        <SelectionProvider>
          <FilterProvider>
            <div className="flex h-screen overflow-hidden">{children}</div>
          </FilterProvider>
        </SelectionProvider>
      </NavigationProvider>
    </RunDataProvider>
  );
};

export default RunLayout;
