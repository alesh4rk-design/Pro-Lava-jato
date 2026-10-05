// Service worker: guarda só os arquivos do app. Respostas da API NUNCA são armazenadas.
// Ao publicar uma nova versão, incremente VERSION.

const VERSION = 'v8';
const CACHE = `lj-shell-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'login.html',
  'dashboard.html',
  'caixa.html',
  'lancamento.html',
  'analise.html',
  'mais.html',
  'admin.html',
  'admin-auditoria.html',
  'auditoria.html',
  'configuracoes.html',
  'usuarios.html',
  'categorias.html',
  'produtos.html',
  'servicos.html',
  'manifest.json',
  'css/global.css',
  'css/components.css',
  'css/mobile.css',
  'js/config.js',
  'js/session.js',
  'js/api.js',
  'js/auth.js',
  'js/firebase.js',
  'js/ui.js',
  'js/pwa.js',
  'js/format.js',
  'js/app.js',
  'js/index.js',
  'js/login.js',
  'js/dashboard.js',
  'js/admin.js',
  'js/usuarios.js',
  'js/categorias.js',
  'js/periods.js',
  'js/catalog.js',
  'js/entry-form.js',
  'js/entry-detail.js',
  'js/receitas.js',
  'js/despesas.js',
  'js/lancamento.js',
  'js/caixa.js',
  'js/estoque.js',
  'js/produtos.js',
  'js/servicos.js',
  'js/analise.js',
  'js/charts.js',
  'js/auditoria.js',
  'js/configuracoes.js',
  'js/audit-labels.js',
  'assets/icons.svg',
  'assets/icons/icon-192.png',
  'assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('lj-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Só arquivos do próprio app; a API (outro domínio) e métodos de escrita passam direto pela rede.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Páginas: rede primeiro (sempre atualizadas); cache só se a conexão falhar.
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(request, { ignoreSearch: true })) ?? caches.match('index.html')),
    );
    return;
  }

  // Arquivos estáticos: responde do cache e atualiza em segundo plano.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached ?? network;
    }),
  );
});
