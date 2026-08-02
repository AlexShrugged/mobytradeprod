import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so a stray lockfile in a parent directory can't hijack it.
  turbopack: {
    root: __dirname,
  },
  // PGlite loads its WASM bundle relative to import.meta.url — bundling breaks that,
  // so it must stay an external package on the server.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
