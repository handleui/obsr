import type { ReactNode } from "react";
import { verifySession } from "@/lib/dal";

interface DashboardLayoutProps {
  children: ReactNode;
}

const DashboardLayout = async ({ children }: DashboardLayoutProps) => {
  await verifySession();

  return (
    <div className="flex h-screen">
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
};

export default DashboardLayout;
