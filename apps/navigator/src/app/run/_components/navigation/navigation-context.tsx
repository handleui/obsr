"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
} from "react";

interface NavigationContextValue {
  basePath: string;
  segments: string[];
  depth: number;
  push: (segment: string) => void;
  pop: () => void;
  navigate: (path: string) => void;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export const useNavigation = () => {
  const ctx = useContext(NavigationContext);
  if (!ctx) {
    throw new Error("useNavigation must be used within NavigationProvider");
  }
  return ctx;
};

interface NavigationProviderProps {
  basePath: string;
  children: ReactNode;
}

export const NavigationProvider = ({
  basePath,
  children,
}: NavigationProviderProps) => {
  const pathname = usePathname();
  const router = useRouter();

  const segments = useMemo(() => {
    const rest = pathname.slice(basePath.length);
    if (!rest || rest === "/") {
      return [];
    }
    return rest.split("/").filter(Boolean);
  }, [pathname, basePath]);

  const depth = segments.length;

  const push = useCallback(
    (segment: string) => {
      router.push(`${basePath}/${[...segments, segment].join("/")}`);
    },
    [router, basePath, segments]
  );

  const pop = useCallback(() => {
    router.push(basePath);
  }, [router, basePath]);

  const navigate = useCallback(
    (path: string) => {
      router.push(`${basePath}/${path}`);
    },
    [router, basePath]
  );

  const value = useMemo(
    () => ({ basePath, segments, depth, push, pop, navigate }),
    [basePath, segments, depth, push, pop, navigate]
  );

  return <NavigationContext value={value}>{children}</NavigationContext>;
};
