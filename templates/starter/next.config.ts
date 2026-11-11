import type { NextConfig } from 'next';

// Platform file: the Builder workspace sets KELAY_TOOLCHAIN_ROOT to the directory that holds both this
// app and the pre-installed SDK toolchain, so the dev server may read packages outside the app folder.
const root = process.env.KELAY_TOOLCHAIN_ROOT;
// A deployed app is served under /<handle>/<app>; the Builder sets this when it builds the bundle.
const basePath = process.env.KELAY_BASE_PATH;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  transpilePackages: ['@kelay/sdk', '@kelay/contracts'],
  ...(root ? { turbopack: { root }, outputFileTracingRoot: root } : {}),
  ...(basePath ? { basePath, env: { NEXT_PUBLIC_KELAY_BASE_PATH: basePath } } : {}),
};

export default nextConfig;
