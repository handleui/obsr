"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { OrgData, OrgMembership } from "@/lib/dal";

interface OrgContextType {
  org: OrgData;
  membership: OrgMembership;
  provider: string;
}

const OrgContext = createContext<OrgContextType | null>(null);

interface OrgProviderProps {
  value: OrgContextType;
  children: ReactNode;
}

export const OrgProvider = ({ value, children }: OrgProviderProps) => (
  <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
);

export const useOrg = (): OrgContextType => {
  const ctx = useContext(OrgContext);
  if (!ctx) {
    throw new Error("useOrg must be used within OrgProvider");
  }
  return ctx;
};
