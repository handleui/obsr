import type { Metadata } from "next";
import { getMockRun } from "../../../../_components/mock-data";
import NavigableLayout from "../../../../_components/navigable-layout";

interface PageProps {
  params: Promise<{ org: string; project: string; run: string }>;
}

export const generateMetadata = async ({
  params,
}: PageProps): Promise<Metadata> => {
  const { org, project } = await params;
  const run = getMockRun(org, project);
  return { title: run?.title ?? "Run Detail" };
};

const RunPage = () => <NavigableLayout />;

export default RunPage;
