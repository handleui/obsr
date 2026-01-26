import { withBetterStack } from "@logtail/next";
import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  experimental: {
    authInterrupts: true,
  },
};

const configWithBetterStack = withBetterStack(nextConfig);

export default withSentryConfig(configWithBetterStack, {
  silent: !process.env.CI,

  // Route Sentry requests through your server to avoid ad-blockers
  tunnelRoute: "/monitoring",

  // Include dependencies in source maps for better stack traces
  widenClientFileUpload: true,

  // Source map configuration for security and debugging
  sourcemaps: {
    // Delete source maps after upload to prevent exposure in production
    deleteSourcemapsAfterUpload: true,
  },

  // Tree-shaking and bundle size optimizations
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
  },

  // Webpack-specific optimizations for tree-shaking
  webpack: {
    // Tree-shake debug logging to reduce bundle size
    treeshake: {
      removeDebugLogging: true,
    },
  },
});
