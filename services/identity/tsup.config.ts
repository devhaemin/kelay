import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  // Workspace packages export TypeScript source, which Node will not load from node_modules.
  noExternal: [/^@kelay\//],
});
