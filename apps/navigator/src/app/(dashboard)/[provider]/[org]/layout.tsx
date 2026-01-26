import { forbidden, notFound } from "next/navigation";
import type { ReactNode } from "react";
import { OrgProvider } from "@/contexts/org-context";
import { fetchMembership, fetchOrg } from "@/lib/dal";

interface OrgLayoutProps {
  children: ReactNode;
  params: Promise<{ provider: string; org: string }>;
}

const OrgLayout = async ({ children, params }: OrgLayoutProps) => {
  const { provider, org } = await params;

  const [orgData, membership] = await Promise.all([
    fetchOrg(provider, org),
    fetchMembership(provider, org),
  ]);

  if (!orgData) {
    notFound();
  }

  if (!membership) {
    forbidden();
  }

  return (
    <OrgProvider value={{ org: orgData, membership, provider }}>
      {children}
    </OrgProvider>
  );
};

export default OrgLayout;
