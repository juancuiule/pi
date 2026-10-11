import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  // effect-pi/api is TypeScript source in the workspace
  transpilePackages: ["effect-pi"],
  // Compression buffers responses, which would hold SSE events back
  compress: false,
  // Tailwind v4 runs as a Turbopack loader
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
  rewrites: () =>
    Promise.resolve([
      { source: "/api/:path*", destination: `${API_URL}/api/:path*` },
    ]),
};

export default nextConfig;
