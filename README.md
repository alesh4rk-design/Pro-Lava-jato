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
- [ ] Etapa 2: D1, Worker, API, autenticação, usuários
- [ ] Etapa 3: receitas, despesas, categorias, caixa
- [ ] Etapa 4: produtos, estoque, serviços, custo por serviço
- [ ] Etapa 5: dashboard real, relatórios, gráficos, ponto de equilíbrio
- [ ] Etapa 6: auditoria, segurança, performance, testes
- [ ] Etapa 7: deploy final e testes em celular

## Rodar localmente

```bash
npm run dev     # http://localhost:5173
npm test        # testes unitários
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

## Publicação do frontend

1. No GitHub: **Settings → Pages → Source: GitHub Actions**.
2. Cada push na branch `main` roda os testes e publica a pasta `frontend/`.

## Segurança (resumo)

- Nenhum segredo no frontend nem no repositório (segredos via `wrangler secret`; `.dev.vars` ignorado).
- CSP rígida em todas as páginas (sem scripts inline, sem CDN); texto sempre inserido via `textContent`.
- Toda validação feita no cliente é repetida no Worker; a interface só esconde, quem bloqueia é a API.
- Dinheiro em centavos (inteiros) para evitar erros de ponto flutuante.
- O service worker nunca armazena respostas da API.
