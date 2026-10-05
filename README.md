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
- [x] **Etapa 3:** receitas, despesas, categorias, caixa e dashboard com dados reais
- [x] **Etapa 4:** produtos, estoque, custo médio, serviços e custo estimado por serviço
- [x] **Etapa 5:** relatórios (financeiro, categorias, serviços, formas de pagamento), gráficos e ponto de equilíbrio
- [x] **Etapa 6:** telas de auditoria, reforços de segurança, desempenho e testes de ponta a ponta
- [ ] Etapa 7: deploy final e testes em celular

## Rodar localmente

```bash
npm run dev       # frontend em http://localhost:5173
npm test          # testes do frontend
npm run test:e2e  # ponta a ponta em tela de celular (sobe API e site sozinho, banco novo)

cd worker
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply lava-jato-db --local
npm run dev     # API em http://127.0.0.1:8787
npm test        # testes da API (rodam no runtime real dos Workers, com D1 local)
```

Com o frontend aberto em `localhost`, ele usa automaticamente a API local (`http://127.0.0.1:8787`).

Para ter um acesso de administrador do sistema local:

```bash
cd worker
npm run create-system-admin
npx wrangler d1 execute lava-jato-db --local --file=.admin.sql && rm .admin.sql
```

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
| GET | `/api/dashboard?period=` | lava-jato |
| GET | `/api/reports/financial` · `categories` · `services` · `break-even` | ADMIN |
| GET | `/api/audit?period=&group=&user_id=` | ADMIN (auditoria do lava-jato) |
| GET | `/api/system/audit?period=` | administrador do sistema |
| GET | `/api/categories?kind=` | lava-jato (ADMIN vê inativas) |
| POST / PUT | `/api/categories` · `/:id` | ADMIN |
| GET | `/api/services` · `/:id` | lava-jato (custos e margens só ADMIN) |
| POST / PUT | `/api/services` · `/:id` | ADMIN |
| PUT | `/api/services/:id/costs` | ADMIN (substitui a composição de custo) |
| GET | `/api/products?low_stock=1` · `/:id` | lava-jato (custo só ADMIN) |
| POST / PUT | `/api/products` · `/:id` | ADMIN |
| POST | `/api/products/:id/movements` | compra e consumo: ADMIN e OPERADOR; ajuste: ADMIN |
| GET / POST | `/api/revenues` · `/api/expenses` | lava-jato (lançar: ADMIN e OPERADOR) |
| GET | `/api/revenues/:id` · `/api/expenses/:id` | lava-jato |
| PUT / DELETE | `/api/revenues/:id` · `/api/expenses/:id` | ADMIN (DELETE = cancelar) |
| GET | `/api/cash?period=` · `/api/cash/entries` | lava-jato |
| POST | `/api/system/auth/login` · `/logout` | administrador do sistema |
| GET | `/api/system/tenants?status=` | administrador do sistema |
| POST | `/api/system/tenants/:id/approve` · `block` · `unblock` | administrador do sistema |

Respostas: `{ "success": true, "data": … }` ou `{ "success": false, "error": { "code", "message" } }`.
Períodos: `period=today|7d|month|last_month|year` ou `period=custom&start=AAAA-MM-DD&end=AAAA-MM-DD`.

**Regras financeiras**
- Faturamento = receitas ativas. Custos = despesas do tipo *custo variável*. Despesas = *fixas* + *outras*.
- Resultado = faturamento − custos − despesas. Margem = resultado ÷ faturamento.
- Serviços = receitas ligadas a um serviço. Ticket médio = faturamento ÷ número de receitas.
- Lançamentos não são apagados: cancelar guarda quem, quando e o motivo, e o valor sai dos totais.
- Datas de lançamento não podem ser futuras; "hoje" segue o fuso `TIMEZONE` (America/Sao_Paulo).

**Estoque e custos**
- Quantidades na menor unidade (ml, g, un); custo médio em micro-reais por unidade (R$ 17,00/L = 17.000 µR/ml).
- Compra recalcula o custo médio ponderado e pode lançar a despesa (custo variável) no caixa, ligada à movimentação.
- Consumo e ajuste usam o custo médio atual; o estoque nunca fica negativo (baixa condicional na transação).
- Custo do serviço = consumo de produtos × custo médio + valores rateados. É uma **estimativa**;
  a receita guarda o custo estimado do momento da venda.

**Ponto de equilíbrio**
- Ponto de equilíbrio = despesas fixas (fixas + outras) ÷ margem de contribuição.
- Margem de contribuição = (faturamento − custos variáveis) ÷ faturamento. Os custos variáveis são o
  **custo estimado dos serviços vendidos** (consumo, não a data da compra); sem composição de custo
  cadastrada, usa os custos variáveis lançados no caixa. A tela informa qual base foi usada.
- Cálculo em inteiros (BigInt): sem erro de arredondamento mesmo com valores altos.

**Gráficos**: Chart.js 4.5.1 (MIT) salvo em `frontend/js/vendor/`, carregado só na tela Análise.
Paleta validada para daltonismo e contraste nos temas claro e escuro; cada gráfico tem versão em tabela.

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

Depois, em `frontend/js/config.js`, troque a URL de produção pela do Worker (+ `/api`).

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
- Auditoria de login, logout, falhas, lançamentos, cancelamentos, preços, estoque, usuários, permissões e
  autorizações, gravada na mesma transação da alteração, sem senhas e com IP guardado só como hash.
  Telas: **Mais → Auditoria** (administrador do lava-jato) e **Clientes → Auditoria** (administrador do sistema).
- Sessão: renovada com o uso (7 dias), mas com validade máxima de 30 dias (7 para o administrador do sistema).
- Limites: 5 tentativas de login por e-mail e 20 por IP a cada 15 min; 3 solicitações de acesso por IP por hora;
  120 gravações por minuto por usuário.
- Limpeza diária automática (Cron Trigger) de sessões vencidas e contadores antigos; lançamentos e auditoria nunca são apagados.
- O app se recusa a rodar dentro de um frame de outro site (proteção contra clickjacking).
- Dependências sem vulnerabilidades conhecidas (`npm audit`); o Worker publicado não tem dependências de execução.

## Testes

- **API** (`worker/test`): rodam no runtime real dos Workers com D1 local. Cobrem login, permissões,
  isolamento entre lava-jatos, receitas, despesas, saldo, margem, ponto de equilíbrio, estoque (inclusive
  concorrência), custos, relatórios, auditoria, valores negativos e gigantes, datas e IDs inválidos,
  SQL injection, XSS, CORS, limites e acesso direto à API. Também garantem que as consultas principais usam índices.
- **Ponta a ponta** (`tests/e2e`): fluxo completo em tela de 360px — solicitação de acesso, autorização,
  cadastros, lançamentos, caixa, cancelamento, análise, auditoria, restrições do operador e ausência de
  rolagem lateral em todas as telas.
- O GitHub Actions roda tudo a cada envio.
