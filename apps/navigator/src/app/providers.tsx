"use client";

import { TooltipProvider } from "@detent/ui/tooltip";

export const Providers = ({ children }: { children: React.ReactNode }) => (
  <TooltipProvider delay={200}>{children}</TooltipProvider>
);
