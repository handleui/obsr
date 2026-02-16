import Link from "next/link";
import NotFoundLogger from "./not-found-logger";

const NotFound = () => (
  <div className="flex min-h-screen flex-col items-center justify-center p-8">
    <NotFoundLogger />
    <h1 className="font-bold text-4xl">404</h1>
    <h2 className="mt-2 text-muted text-xl">Page not found</h2>
    <p className="mt-4 text-dim">
      The page you&apos;re looking for doesn&apos;t exist.
    </p>
    <Link
      className="mt-6 bg-black px-4 py-2 text-white hover:bg-zinc-800"
      href="/"
    >
      Go home
    </Link>
  </div>
);

export default NotFound;
