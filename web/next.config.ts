// Validates the environment (the root .env.schema, through web/.env.schema); reuses what `varlock run` injected.
import "varlock/auto-load";
import type { NextConfig } from "next";
import { ENV } from "varlock/env";

const nextConfig: NextConfig = {
  // effect-pi/api is TypeScript source in the workspace
  transpilePackages: ["effect-pi", "@wterm/dom", "@wterm/react"],
  // Compression buffers responses, which would hold SSE events back
  compress: false,
  experimental: {
    // The rewrite proxy destroys a request after this long without bytes (30s by default); an SSE stream is silent
    // while its conversation is idle or a tool runs, so allow a day.
    proxyTimeout: 24 * 60 * 60 * 1000,
  },
  // Tailwind v4 runs as a Turbopack loader
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
  rewrites: () =>
    Promise.resolve([
      { source: "/api/:path*", destination: `${ENV.API_URL}/api/:path*` },
    ]),
};

export default nextConfig;
