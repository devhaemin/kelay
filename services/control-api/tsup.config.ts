import { defineConfig } from 'tsup';

// One self-contained bundle per entry, so the runtime image needs no node_modules.
export default defineConfig({
  entry: { server: 'src/server.ts', migrate: 'src/migrate.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/.*/],
  external: ['pg-native'],
  // Bundled CommonJS dependencies call require() for Node built-ins.
  banner: { js: "import { createRequire as __kelayCreateRequire } from 'node:module'; const require = __kelayCreateRequire(import.meta.url);" },
});
