import { Logger } from "@logtail/next";
import { headers } from "next/headers";
import Link from "next/link";

export default async function NotFound() {
  const log = new Logger({ source: "not-found.tsx" });
  const headersList = await headers();
  const referer = headersList.get("referer");

  log.warn("Page not found", {
    statusCode: 404,
    referer,
  });
  await log.flush();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="font-bold text-4xl">404</h1>
      <h2 className="mt-2 text-gray-600 text-xl">Page not found</h2>
      <p className="mt-4 text-gray-500">
        The page you&apos;re looking for doesn&apos;t exist.
      </p>
      <Link
        className="mt-6 rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        href="/"
      >
        Go home
      </Link>
    </div>
  );
}
