import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchProject } from "@/lib/dal";

interface ProjectPageProps {
  params: Promise<{
    provider: string;
    org: string;
    project: string;
  }>;
}

const ProjectPage = async ({ params }: ProjectPageProps) => {
  const { provider, org, project } = await params;

  // Uses cached fetchProject - deduplicates with layout fetch
  const data = await fetchProject(provider, org, project);

  if (!data) {
    notFound();
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="font-bold text-2xl">{data.handle}</h1>
        <p className="text-neutral-500">{data.provider_repo_full_name}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Link
          className="rounded-lg border border-neutral-200 p-4 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
          href={`/${provider}/${org}/${project}/runs`}
        >
          <h2 className="font-medium text-neutral-900">CI Runs</h2>
          <p className="text-neutral-500 text-sm">View CI run history</p>
        </Link>

        <Link
          className="rounded-lg border border-neutral-200 p-4 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
          href={`/${provider}/${org}/${project}/heals`}
        >
          <h2 className="font-medium text-neutral-900">AI Heals</h2>
          <p className="text-neutral-500 text-sm">View AI healing history</p>
        </Link>
      </div>

      <div className="mt-6 rounded-lg border border-neutral-200 p-4">
        <h2 className="mb-2 font-medium text-neutral-900">Project Details</h2>
        <dl className="space-y-2 text-sm">
          <div className="flex">
            <dt className="w-32 text-neutral-500">Default Branch</dt>
            <dd className="text-neutral-900">
              {data.provider_default_branch ?? "Not set"}
            </dd>
          </div>
          <div className="flex">
            <dt className="w-32 text-neutral-500">Visibility</dt>
            <dd className="text-neutral-900">
              {data.is_private ? "Private" : "Public"}
            </dd>
          </div>
          <div className="flex">
            <dt className="w-32 text-neutral-500">Created</dt>
            <dd className="text-neutral-900">
              {new Date(data.created_at).toLocaleDateString()}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
};

export default ProjectPage;
