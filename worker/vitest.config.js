import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ALLOWED_ORIGINS: 'https://app.teste',
            IP_HASH_SALT: 'sal-de-teste',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.js'],
    },
  };
});
