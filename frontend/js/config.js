// Configuração pública do frontend. NUNCA coloque segredos aqui: este arquivo é enviado ao navegador.

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

export const config = Object.freeze({
  // Em desenvolvimento, a API roda com `wrangler dev`; em produção, no Cloudflare Workers.
  // Substitua a URL de produção pela exibida em `npm run deploy` (Etapa 7).
  API_BASE_URL: isLocal ? 'http://127.0.0.1:8787/api' : 'https://lava-jato-api.workers.dev/api',

  // Firebase Authentication (guarda e-mail e senha). A chave da API é PÚBLICA por definição (veja docs/PUBLICACAO.md).
  // Em desenvolvimento e nos testes, usa o Firebase falso (tests/e2e/fake-firebase.mjs), mesma API do emulador.
  FIREBASE_API_KEY: isLocal ? 'chave-local' : 'COLE-AQUI-A-CHAVE-DA-API-DO-FIREBASE',
  FIREBASE_AUTH_URL: isLocal ? 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1' : 'https://identitytoolkit.googleapis.com/v1',

  REQUEST_TIMEOUT_MS: 15000,
  TIMEZONE: 'America/Sao_Paulo',
  APP_NAME: 'Lava-Jato Gestão',
});
