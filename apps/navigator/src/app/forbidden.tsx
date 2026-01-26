import Link from "next/link";

const ForbiddenPage = () => (
  <div className="flex min-h-screen flex-col items-center justify-center p-8">
    <h1 className="font-bold text-4xl">403</h1>
    <h2 className="mt-2 text-neutral-600 text-xl">Forbidden</h2>
    <p className="mt-4 text-neutral-500">
      You do not have permission to access this resource.
    </p>
    <Link
      className="mt-6 rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
      href="/"
    >
      Go Home
    </Link>
  </div>
);

export default ForbiddenPage;
