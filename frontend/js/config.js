// Configuração pública do frontend. NUNCA coloque segredos aqui: este arquivo é enviado ao navegador.

export const config = Object.freeze({
  // URL do Cloudflare Worker (definida na Etapa 2/7).
  API_BASE_URL: 'https://lava-jato-api.workers.dev/api',

  // Modo demonstração: respostas simuladas localmente enquanto o Worker não existe.
  // Deve ser false em produção.
  USE_MOCK: true,

  REQUEST_TIMEOUT_MS: 15000,
  TIMEZONE: 'America/Sao_Paulo',
  APP_NAME: 'Lava-Jato Gestão',
});
