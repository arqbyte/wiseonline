import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a minimal, self-contained `.next/standalone` server (only the
  // node_modules actually required at runtime, traced via @vercel/nft) so
  // the Docker runtime image doesn't need the full workspace node_modules.
  // See apps/web/Dockerfile.
  output: "standalone",
  // This is a pnpm workspace: the lockfile/workspace root lives two levels
  // up from apps/web. Without this, Next.js has to guess the tracing root
  // from lockfile location, which prints a warning and can mis-resolve in
  // Docker builds where the build context is the monorepo root.
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
