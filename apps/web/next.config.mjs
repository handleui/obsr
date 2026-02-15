import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactCompiler: true,
  turbopack: {
    root: "../..",
  },
  async redirects() {
    return [
      {
        source: "/demo",
        destination: "https://navigator.detent.sh/demo",
        permanent: false,
      },
    ];
  },
};

export default withMDX(nextConfig);
