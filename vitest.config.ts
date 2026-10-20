import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false, // tests share one Postgres database
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://turnly:turnly@localhost:5432/turnly_test',
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
  },
});
