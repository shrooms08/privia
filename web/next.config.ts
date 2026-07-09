import type { NextConfig } from "next";

// Same-origin proxy to the Canton JSON Ledger API — avoids CORS entirely.
// The browser client calls /ledger-api/v2/...; Next rewrites to the participant.
const LEDGER_API_URL = process.env.LEDGER_API_URL ?? "http://localhost:7575";

const nextConfig: NextConfig = {
  // Repo root holds the Daml project; pin the workspace root so Turbopack
  // doesn't pick a stray lockfile above the repo.
  turbopack: { root: import.meta.dirname },
  async rewrites() {
    return [
      {
        source: "/ledger-api/:path*",
        destination: `${LEDGER_API_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
