import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactCompiler: true,
  turbopack: {
    root: "../..",
  },
};

export default withMDX(nextConfig);
