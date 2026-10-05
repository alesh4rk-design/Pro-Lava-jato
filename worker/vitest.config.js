import { generateKeyPairSync } from 'node:crypto';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  // Chaves só dos testes: simulam o Google/Firebase (o Worker confere a assinatura com a pública).
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'chave-teste', alg: 'RS256', use: 'sig' }] };
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ALLOWED_ORIGINS: 'https://app.teste',
            IP_HASH_SALT: 'sal-de-teste',
            FIREBASE_PROJECT_ID: 'projeto-teste',
            FIREBASE_JWKS_JSON: JSON.stringify(jwks),
            TEST_FIREBASE_PRIVATE_JWK: JSON.stringify(privateKey.export({ format: 'jwk' })),
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.js'],
    },
  };
});
