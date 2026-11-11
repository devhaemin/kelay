import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// The repo is a pnpm workspace that may itself sit inside another checkout (git worktrees),
// so pin the root instead of letting Next pick the outermost lockfile.
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  // The dev badge sits where the prototype's Story bar does (bottom left).
  devIndicators: false,
  transpilePackages: ['@kelay/contracts', '@kelay/policy'],
  // The production image (Dockerfile) runs the standalone server and ships no node_modules of its own.
  output: 'standalone',
  // The e2e suite runs its own dev server next to a `pnpm dev:up` one; two cannot share a build folder.
  ...(process.env.CONSOLE_DIST_DIR ? { distDir: process.env.CONSOLE_DIST_DIR } : {}),
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
};

export default nextConfig;
