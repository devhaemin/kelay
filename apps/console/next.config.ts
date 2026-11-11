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
  transpilePackages: ['@kelay/contracts'],
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
};

export default nextConfig;
