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

interface NavCardProps {
  href: string;
  title: string;
  description: string;
}

const NAV_CARD_CLASS =
  "rounded-lg border border-neutral-200 p-4 transition-colors hover:border-neutral-300 hover:bg-neutral-50";

const NavCard = ({ href, title, description }: NavCardProps) => (
  <Link className={NAV_CARD_CLASS} href={href}>
    <h2 className="font-medium text-neutral-900">{title}</h2>
    <p className="text-neutral-500 text-sm">{description}</p>
  </Link>
);

interface DetailRowProps {
  label: string;
  value: string;
}

const DetailRow = ({ label, value }: DetailRowProps) => (
  <div className="flex">
    <dt className="w-32 text-neutral-500">{label}</dt>
    <dd className="text-neutral-900">{value}</dd>
  </div>
);

const ProjectPage = async ({ params }: ProjectPageProps) => {
  const { provider, org, project } = await params;

  const data = await fetchProject(provider, org, project);

  if (!data) {
    notFound();
  }

  const basePath = `/${encodeURIComponent(provider)}/${encodeURIComponent(org)}/${encodeURIComponent(project)}`;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="font-bold text-2xl">{data.handle}</h1>
        <p className="text-neutral-500">{data.provider_repo_full_name}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <NavCard
          description="View CI run history"
          href={`${basePath}/runs`}
          title="CI Runs"
        />
        <NavCard
          description="View AI healing history"
          href={`${basePath}/heals`}
          title="AI Heals"
        />
      </div>

      <div className="mt-6 rounded-lg border border-neutral-200 p-4">
        <h2 className="mb-2 font-medium text-neutral-900">Project Details</h2>
        <dl className="space-y-2 text-sm">
          <DetailRow
            label="Default Branch"
            value={data.provider_default_branch ?? "Not set"}
          />
          <DetailRow
            label="Visibility"
            value={data.is_private ? "Private" : "Public"}
          />
          <DetailRow
            label="Created"
            value={new Date(data.created_at).toLocaleDateString()}
          />
        </dl>
      </div>
    </div>
  );
};

export default ProjectPage;
