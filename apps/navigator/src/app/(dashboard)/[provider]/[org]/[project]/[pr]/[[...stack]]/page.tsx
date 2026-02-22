import type { Metadata } from "next";
import NavigableLayout from "@/components/features/checks/ui/v1/navigable-layout";

interface PageProps {
  params: Promise<{
    provider: string;
    org: string;
    project: string;
    pr: string;
    stack?: string[];
  }>;
}

export const generateMetadata = async ({
  params,
}: PageProps): Promise<Metadata> => {
  const { project, pr } = await params;
  const safePr = Number.parseInt(pr, 10);
  const safeProject = project.replace(/[^a-zA-Z0-9._-]/g, "");
  if (Number.isNaN(safePr) || !safeProject) {
    return { title: "Pull Request" };
  }
  return { title: `PR #${safePr} — ${safeProject}` };
};

const PrPage = () => <NavigableLayout />;

export default PrPage;
