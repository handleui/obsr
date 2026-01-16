import { Button } from "@detent/ui/button";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { signOut } from "@/lib/auth-actions";

const DashboardPage = async () => {
  const { isAuthenticated, user } = await getUser();

  if (!isAuthenticated) {
    redirect("/login");
  }

  const productId = process.env.NEXT_PUBLIC_POLAR_PRODUCT_ID;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-white">
      <p className="text-zinc-600">
        {user?.firstName || user?.email}? How'd you get here?
      </p>
      <div className="flex gap-3">
        {productId && (
          <Button asChild>
            <a href={`/api/checkout?products=${productId}`}>Add Credits</a>
          </Button>
        )}
        <form action={signOut}>
          <Button type="submit" variant="outline">
            Sign out
          </Button>
        </form>
      </div>
    </main>
  );
};

export default DashboardPage;
