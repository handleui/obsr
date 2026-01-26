import { notFound } from "next/navigation";
import type { ReactNode } from "react";

const VALID_PROVIDERS = ["gh", "gl"] as const;

type Provider = (typeof VALID_PROVIDERS)[number];

interface ProviderLayoutProps {
  children: ReactNode;
  params: Promise<{ provider: string }>;
}

const isValidProvider = (provider: string): provider is Provider =>
  VALID_PROVIDERS.includes(provider as Provider);

const ProviderLayout = async ({ children, params }: ProviderLayoutProps) => {
  const { provider } = await params;

  if (!isValidProvider(provider)) {
    notFound();
  }

  return <>{children}</>;
};

export default ProviderLayout;
