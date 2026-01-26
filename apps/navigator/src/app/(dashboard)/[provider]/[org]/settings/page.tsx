import { forbidden } from "next/navigation";
import { isOrgAdmin } from "@/lib/dal";

interface OrgSettingsPageProps {
  params: Promise<{
    provider: string;
    org: string;
  }>;
}

const OrgSettingsPage = async ({ params }: OrgSettingsPageProps) => {
  const { provider, org } = await params;

  const hasAccess = await isOrgAdmin(provider, org);
  if (!hasAccess) {
    forbidden();
  }

  return (
    <div className="p-6">
      <h1 className="mb-6 font-bold text-2xl">Organization Settings</h1>
      <p className="text-neutral-500">
        Settings for {org} will be available here.
      </p>
    </div>
  );
};

export default OrgSettingsPage;
