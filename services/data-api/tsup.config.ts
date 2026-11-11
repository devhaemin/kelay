import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The runtime image ships dist/ only, so every dependency is bundled. pg-native is an
  // optional peer of pg that is never loaded unless requested.
  noExternal: [/^(?!pg-native$)/],
  external: ['pg-native'],
  // Bundled CommonJS dependencies (pg) call require() for Node built-ins.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
