import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();
const filePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(filePath);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactCompiler: true,
  turbopack: {
    root: path.resolve(currentDir, "../.."),
  },
};

export default withMDX(nextConfig);
