import Link from "next/link";

interface PageProps {
  searchParams: Promise<{ checkout_id?: string }>;
}

const BillingSuccessPage = async ({ searchParams }: PageProps) => {
  const { checkout_id } = await searchParams;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="font-bold text-2xl">Payment Successful</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Your credits have been added to your account.
      </p>
      {checkout_id && (
        <p className="text-xs text-zinc-500 dark:text-zinc-500">
          Order: {checkout_id}
        </p>
      )}
      <Link
        className="rounded-lg border border-zinc-300 px-6 py-3 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        href="/"
      >
        Back to Dashboard
      </Link>
    </main>
  );
};

export default BillingSuccessPage;
