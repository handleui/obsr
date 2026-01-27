import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  async rewrites() {
    return [
      {
        source: "/docs",
        destination: "https://detent.apidocumentation.com/",
      },
      {
        source: "/docs/:path*",
        destination: "https://detent.apidocumentation.com/:path*",
      },
    ];
  },
};

export default nextConfig;
