import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const filePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(filePath);

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(currentDir, "../.."),
  reactCompiler: true,
  transpilePackages: ["@obsr/ai", "@obsr/issues", "@obsr/types"],
  turbopack: {
    root: path.resolve(currentDir, "../.."),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
