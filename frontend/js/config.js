// Configuração pública do frontend. NUNCA coloque segredos aqui: este arquivo é enviado ao navegador.

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

export const config = Object.freeze({
  // Em desenvolvimento, a API roda com `wrangler dev`; em produção, no Cloudflare Workers.
  // Substitua a URL de produção pela exibida em `npm run deploy` (Etapa 7).
  API_BASE_URL: isLocal ? 'http://127.0.0.1:8787/api' : 'https://lava-jato-api.workers.dev/api',

  REQUEST_TIMEOUT_MS: 15000,
  TIMEZONE: 'America/Sao_Paulo',
  APP_NAME: 'Lava-Jato Gestão',
});
