import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const filePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(filePath);

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    root: path.resolve(currentDir, "../.."),
  },
};

export default nextConfig;
