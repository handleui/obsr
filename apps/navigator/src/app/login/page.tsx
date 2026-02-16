import { redirect } from "next/navigation";
import { gitlab } from "@/flags";
import { getUser, isValidReturnUrl, sanitizeReturnUrl } from "@/lib/auth";
import { LoginPageClient } from "./login-page";

interface LoginPageProps {
  searchParams: Promise<{ returnTo?: string }>;
}

const LoginPage = async ({ searchParams }: LoginPageProps) => {
  const { isAuthenticated } = await getUser();
  const params = await searchParams;

  if (isAuthenticated) {
    const safeReturnTo = sanitizeReturnUrl(params.returnTo, "/");
    redirect(safeReturnTo);
  }

  const showGitlab = await gitlab();
  const returnTo = isValidReturnUrl(params.returnTo)
    ? params.returnTo
    : undefined;

  return <LoginPageClient returnTo={returnTo} showGitlab={showGitlab} />;
};

export default LoginPage;
