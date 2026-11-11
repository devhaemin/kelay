import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // Workspace packages export TypeScript source, so they must be bundled; bundling the rest as well
  // leaves the runtime image without node_modules. Bundled CommonJS dependencies need `require`.
  noExternal: [/.*/],
  banner: { js: "import { createRequire as __kelayCreateRequire } from 'node:module'; const require = __kelayCreateRequire(import.meta.url);" },
});
