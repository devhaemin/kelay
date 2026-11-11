import type { NextConfig } from 'next';

// Platform file: the Builder workspace sets KELAY_TOOLCHAIN_ROOT to the directory that holds both this
// app and the pre-installed SDK toolchain, so the dev server may read packages outside the app folder.
const root = process.env.KELAY_TOOLCHAIN_ROOT;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  transpilePackages: ['@kelay/sdk', '@kelay/contracts'],
  ...(root ? { turbopack: { root }, outputFileTracingRoot: root } : {}),
};

export default nextConfig;
