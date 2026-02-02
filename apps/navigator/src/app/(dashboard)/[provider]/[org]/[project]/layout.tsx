import { forbidden, notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ProjectProvider } from "@/contexts/project-context";
import { fetchMembership, fetchOrg, fetchProject } from "@/lib/dal";

interface ProjectLayoutProps {
  children: ReactNode;
  params: Promise<{ provider: string; org: string; project: string }>;
}

const ProjectLayout = async ({ children, params }: ProjectLayoutProps) => {
  const { provider, org, project } = await params;

  const [orgData, membership, projectData] = await Promise.all([
    fetchOrg(provider, org),
    fetchMembership(provider, org),
    fetchProject(provider, org, project),
  ]);

  if (!orgData) {
    notFound();
  }

  if (!membership) {
    forbidden();
  }

  if (!projectData) {
    notFound();
  }

  return (
    <ProjectProvider value={{ project: projectData }}>
      {children}
    </ProjectProvider>
  );
};

export default ProjectLayout;
