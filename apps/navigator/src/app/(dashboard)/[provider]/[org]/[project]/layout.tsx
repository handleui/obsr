import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ProjectProvider } from "@/contexts/project-context";
import { fetchProject } from "@/lib/dal";

interface ProjectLayoutProps {
  children: ReactNode;
  params: Promise<{ provider: string; org: string; project: string }>;
}

const ProjectLayout = async ({ children, params }: ProjectLayoutProps) => {
  const { provider, org, project } = await params;

  const projectData = await fetchProject(provider, org, project);

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
