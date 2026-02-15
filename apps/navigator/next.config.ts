import { withBetterStack } from "@logtail/next";
import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  transpilePackages: ["@detent/sentry"],
  experimental: {
    optimizePackageImports: ["iconoir-react"],
  },
};

const configWithBetterStack =
  process.env.NODE_ENV === "production"
    ? withBetterStack(nextConfig)
    : nextConfig;

export default withSentryConfig(configWithBetterStack, {
  silent: !process.env.CI,
  tunnelRoute: "/monitoring",
  widenClientFileUpload: true,
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
  },
  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
});
