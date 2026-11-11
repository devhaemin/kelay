import { defineConfig } from 'tsup';

// One self-contained bundle, so the runtime image needs no node_modules.
export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/.*/],
  // pg-native is an optional peer of pg that is never loaded unless requested.
  external: ['pg-native'],
  // Bundled CommonJS dependencies call require() for Node built-ins.
  banner: { js: "import { createRequire as __kelayCreateRequire } from 'node:module'; const require = __kelayCreateRequire(import.meta.url);" },
});
