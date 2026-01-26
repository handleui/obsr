import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchProjects } from "@/lib/dal";

interface OrgPageProps {
  params: Promise<{
    provider: string;
    org: string;
  }>;
}

const OrgPage = async ({ params }: OrgPageProps) => {
  const { provider, org } = await params;

  const data = await fetchProjects(provider, org);

  if (!data) {
    notFound();
  }

  return (
    <div className="p-6">
      <h1 className="mb-6 font-bold text-2xl">{org}</h1>

      {data.projects.length === 0 ? (
        <p className="text-neutral-500">No projects yet.</p>
      ) : (
        <div className="grid gap-4">
          {data.projects.map((project) => (
            <Link
              className="block rounded-lg border border-neutral-200 p-4 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
              href={`/${provider}/${org}/${project.handle}`}
              key={project.id}
            >
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-medium text-neutral-900">
                    {project.handle}
                  </h2>
                  <p className="text-neutral-500 text-sm">
                    {project.provider_repo_full_name}
                  </p>
                </div>
                {project.is_private && (
                  <span className="rounded bg-neutral-100 px-2 py-1 font-medium text-neutral-600 text-xs">
                    Private
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
};

export default OrgPage;
