import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { source } from "@/lib/source";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      nav={{
        title: "Detent",
        url: "/",
      }}
      tree={source.getPageTree()}
    >
      {children}
    </DocsLayout>
  );
}
