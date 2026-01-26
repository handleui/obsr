import { forbidden } from "next/navigation";
import { isOrgAdmin } from "@/lib/dal";

interface ProjectSettingsPageProps {
  params: Promise<{
    provider: string;
    org: string;
    project: string;
  }>;
}

const ProjectSettingsPage = async ({ params }: ProjectSettingsPageProps) => {
  const { provider, org, project } = await params;

  const hasAccess = await isOrgAdmin(provider, org);
  if (!hasAccess) {
    forbidden();
  }

  return (
    <div className="p-6">
      <h1 className="mb-6 font-bold text-2xl">Project Settings</h1>
      <p className="text-neutral-500">
        Settings for {project} will be available here.
      </p>
    </div>
  );
};

export default ProjectSettingsPage;
