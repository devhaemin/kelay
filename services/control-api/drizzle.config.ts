import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env.CONTROL_DATABASE_URL ?? 'postgres://kelay:kelay@localhost:54320/kelay_control' },
});
