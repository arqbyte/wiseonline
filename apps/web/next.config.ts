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
  // Proxies /api/* to the NestJS API so Better Auth's session cookie is
  // always same-origin — no CORS, no third-party-cookie exposure, and in
  // prod this is what lets the cookie use the `__Host-` prefix (no `Domain=`
  // attribute needed; PRD §2.2, card 1.3 AC). `API_ORIGIN` is server-only
  // (no `NEXT_PUBLIC_` prefix): this rewrite runs on the Next.js server,
  // never in the browser, so the API's real origin is never exposed to
  // client JS.
  async rewrites() {
    const apiOrigin = process.env.API_ORIGIN;
    if (!apiOrigin) {
      throw new Error(
        "API_ORIGIN is not set — required so /api/* rewrites reach the " +
          "NestJS API and Better Auth's session cookie stays same-origin " +
          "(PRD §2.2). See .env.example.",
      );
    }
    return [
      {
        source: "/api/:path*",
        destination: `${apiOrigin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
