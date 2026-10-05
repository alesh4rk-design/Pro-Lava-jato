// Testes de ponta a ponta: API real (wrangler dev, banco novo) + site estático, em tela de celular.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.mjs',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173/',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'celular', use: { ...devices['Pixel 5'], viewport: { width: 360, height: 760 } } }],
  webServer: [
    { command: 'node tests/e2e/serve.mjs', url: 'http://localhost:5173/login.html', reuseExistingServer: false },
    { command: 'sh worker/scripts/e2e-api.sh', url: 'http://127.0.0.1:8787/api/health', timeout: 120_000, reuseExistingServer: false },
  ],
});
