import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@excalidraw/excalidraw"],
};

export default nextConfig;
