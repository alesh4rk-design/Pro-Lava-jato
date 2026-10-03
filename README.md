# Lava-Jato Gestão

Sistema web (PWA) de controle financeiro para lava-jatos, feito para uso no celular.

```
GitHub Pages (frontend estático, sem segredos)
      │ HTTPS + Bearer token
Cloudflare Worker (API: CORS → rate limit → autenticação → RBAC → validação → regra de negócio → auditoria)
      │
Cloudflare D1 (SQLite, dinheiro em centavos)
```

## Acessos

| Perfil | Onde entra | O que faz |
|---|---|---|
| Administrador do sistema | Login → "Entrar como administrador do sistema" | Autoriza, bloqueia e desbloqueia lava-jatos |
| Administrador do lava-jato | Login normal | Responsável pelos lançamentos; tudo do lava-jato |
| Operador | Login normal | Registra receitas e despesas, vê o dashboard |

Um novo lava-jato usa **"Solicitar acesso"** na tela de login, informando o próprio nome. A conta fica
**pendente** até o administrador do sistema autorizar. O nome do lava-jato aparece no topo do app.

## Etapas

- [x] **Etapa 1:** estrutura, design mobile, PWA, login, painel do administrador do sistema, dashboard visual
- [x] **Etapa 2:** D1, Worker, API, autenticação, sessões, RBAC, usuários e painel do administrador do sistema
- [ ] Etapa 3: receitas, despesas, categorias, caixa
- [ ] Etapa 4: produtos, estoque, serviços, custo por serviço
- [ ] Etapa 5: dashboard real, relatórios, gráficos, ponto de equilíbrio
- [ ] Etapa 6: auditoria, segurança, performance, testes
- [ ] Etapa 7: deploy final e testes em celular

## Rodar localmente

```bash
npm run dev     # frontend em http://localhost:5173
npm test        # testes do frontend

cd worker
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply lava-jato-db --local
npm run dev     # API em http://127.0.0.1:8787
npm test        # testes da API (rodam no runtime real dos Workers, com D1 local)
```

### Modo demonstração (Etapa 1)

Enquanto o Worker não existe, `frontend/js/config.js` usa `USE_MOCK: true`: as respostas são simuladas
no navegador e **nada é salvo**. Qualquer e-mail válido com senha de 8+ caracteres entra. O início
do e-mail simula situações:

| E-mail | Resultado |
|---|---|
| `qualquer@...` | Administrador do lava-jato |
| `operador@...` | Operador |
| `pendente@...` | Acesso aguardando autorização |
| `bloqueado@...` | Acesso bloqueado |
| `erro@...` | Falha do servidor |

## API (Cloudflare Worker)

| Método | Rota | Acesso |
|---|---|---|
| POST | `/api/auth/login` | público (limite de tentativas) |
| POST | `/api/auth/logout` | lava-jato |
| GET | `/api/auth/me` | lava-jato |
| POST | `/api/auth/password` | lava-jato |
| POST | `/api/access-requests` | público (limite por IP) |
| GET / POST | `/api/users` | ADMIN |
| PUT | `/api/users/:id` | ADMIN |
| POST | `/api/users/:id/password` | ADMIN |
| POST | `/api/system/auth/login` · `/logout` | administrador do sistema |
| GET | `/api/system/tenants?status=` | administrador do sistema |
| POST | `/api/system/tenants/:id/approve` · `block` · `unblock` | administrador do sistema |

Respostas: `{ "success": true, "data": … }` ou `{ "success": false, "error": { "code", "message" } }`.
As permissões de cada rota ficam numa única tabela em `worker/src/index.js`.

### Primeiro deploy da API

```bash
cd worker
npx wrangler login
npx wrangler d1 create lava-jato-db          # copie o database_id para wrangler.toml
npx wrangler d1 migrations apply lava-jato-db --remote
npx wrangler secret put IP_HASH_SALT         # cole um texto aleatório longo
npm run deploy                               # anote a URL *.workers.dev

npm run create-system-admin                  # cria o SEU acesso (senha não aparece na tela)
npx wrangler d1 execute lava-jato-db --remote --file=.admin.sql && rm .admin.sql
```

Depois, em `frontend/js/config.js`: `API_BASE_URL` = URL do Worker + `/api` e `USE_MOCK: false`.
O dashboard real chega na Etapa 5; até lá, a tela Início mostra erro com a API real.

## Publicação do frontend

1. No GitHub: **Settings → Pages → Source: GitHub Actions**.
2. Cada push na branch `main` roda os testes e publica a pasta `frontend/`.

## Segurança (resumo)

- Nenhum segredo no frontend nem no repositório (segredos via `wrangler secret`; `.dev.vars` ignorado).
- CSP rígida em todas as páginas (sem scripts inline, sem CDN); texto sempre inserido via `textContent`.
- Toda validação feita no cliente é repetida no Worker; a interface só esconde, quem bloqueia é a API.
- Dinheiro em centavos (inteiros) para evitar erros de ponto flutuante.
- O service worker nunca armazena respostas da API.
- Senhas com PBKDF2-SHA256 (100 mil iterações, salt aleatório); do token de sessão, só o hash vai ao banco.
- Bloquear um lava-jato, desativar um usuário ou trocar senha derruba as sessões na hora.
- Cada lava-jato só enxerga os próprios dados: filtro por `tenant_id` em toda consulta e chaves
  estrangeiras compostas no banco.
- Auditoria de login, logout, falhas, usuários, permissões e autorizações, gravada na mesma transação
  da alteração, sem senhas e com IP guardado só como hash.
