import Link from "next/link";
import { isValidReturnUrl } from "@/lib/auth";

interface UnauthorizedProps {
  searchParams: Promise<{
    returnTo?: string;
  }>;
}

const UnauthorizedPage = async ({ searchParams }: UnauthorizedProps) => {
  const { returnTo } = await searchParams;
  const safeReturnTo = isValidReturnUrl(returnTo) ? returnTo : null;
  const loginUrl = safeReturnTo
    ? `/login?returnTo=${encodeURIComponent(safeReturnTo)}`
    : "/login";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="font-bold text-4xl">401</h1>
      <h2 className="mt-2 text-neutral-600 text-xl">Unauthorized</h2>
      <p className="mt-4 text-neutral-500">
        You need to sign in to access this page.
      </p>
      <Link
        className="mt-6 rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        href={loginUrl}
      >
        Sign in
      </Link>
    </div>
  );
};

export default UnauthorizedPage;
