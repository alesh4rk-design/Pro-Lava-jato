# Guia de publicação (passo a passo)

Este guia coloca o sistema no ar usando só serviços **gratuitos**: o **GitHub Pages** hospeda as telas e a **Cloudflare** hospeda a API e o banco de dados.
Tempo estimado: 30 a 40 minutos, na primeira vez.

Você vai precisar de:
- uma conta no **GitHub** (você já tem) e uma conta gratuita na **Cloudflare**;
- um computador com o **Node.js 22** instalado (https://nodejs.org, versão LTS) e o **Git**.

> O celular serve para **usar** o sistema. Para publicar, use um computador.

---

## Parte 1 — Publicar as telas (GitHub Pages)

1. O código precisa estar na branch principal (`main`). Se ainda não estiver, peça para o Claude abrir o *pull request* e faça o merge no GitHub.
2. No repositório, abra **Settings → Pages**.
3. Em **Build and deployment → Source**, escolha **GitHub Actions**.
4. Abra a aba **Actions**: o fluxo **"Publicar frontend (GitHub Pages)"** roda sozinho depois do merge. Quando ficar verde, o endereço aparece nele.
   O endereço será parecido com `https://alesh4rk-design.github.io/Pro-Lava-jato/`.

Neste ponto as telas já abrem, mas ainda **não funcionam**: falta a API (Parte 2).

---

## Parte 2 — Publicar a API e o banco (Cloudflare)

No computador, abra o terminal na pasta do projeto e rode os comandos abaixo, **um de cada vez**.

### 2.1 Preparar

```bash
git clone https://github.com/alesh4rk-design/Pro-Lava-jato.git
cd Pro-Lava-jato/worker
npm ci
npx wrangler login
```

O último comando abre o navegador para você entrar na Cloudflare e autorizar.

### 2.2 Criar o banco de dados

```bash
npx wrangler d1 create lava-jato-db
```

O comando mostra um `database_id` (um código longo). **Copie esse código** e cole no arquivo `worker/wrangler.toml`, no lugar de `00000000-0000-0000-0000-000000000000`. Esse código não é segredo.

### 2.3 Criar as tabelas

```bash
npx wrangler d1 migrations apply lava-jato-db --remote
```

### 2.4 Definir o segredo dos registros de auditoria

```bash
npx wrangler secret put IP_HASH_SALT
```

Quando pedir, digite um texto longo e aleatório (30 letras e números ou mais) e aperte Enter. **Não** é uma senha de acesso: só protege os endereços de IP guardados na auditoria. Guarde o texto em lugar seguro, pois não é possível lê-lo depois.

### 2.5 Publicar a API

```bash
npm run deploy
```

No final aparece o endereço da API, parecido com `https://lava-jato-api.SEU-USUARIO.workers.dev`. **Anote.**

Teste no navegador: abra `https://lava-jato-api.SEU-USUARIO.workers.dev/api/health`. Deve aparecer `{"success":true,"data":{"status":"ok"}}`.

### 2.6 Criar o SEU acesso de administrador do sistema

```bash
npm run create-system-admin
npx wrangler d1 execute lava-jato-db --remote --file=.admin.sql
```

(No Windows, apague depois o arquivo `.admin.sql` manualmente; no Mac/Linux use `rm .admin.sql`.)

O primeiro comando pergunta nome, e-mail e senha (a senha **não aparece** na tela). Use uma senha forte e exclusiva. Esse é o acesso do botão **"Entrar como administrador do sistema"** na tela de login.

---

## Parte 3 — Conectar as telas à API

1. No GitHub, abra o arquivo `frontend/js/config.js` e clique no lápis (editar).
2. Troque `https://lava-jato-api.workers.dev/api` pelo endereço anotado na etapa 2.5, **mantendo `/api` no final**.
   Exemplo: `https://lava-jato-api.SEU-USUARIO.workers.dev/api`
3. Se o endereço do seu GitHub Pages **não** for `https://alesh4rk-design.github.io`, ajuste também `ALLOWED_ORIGINS` em `worker/wrangler.toml` (só o endereço, sem barra no final e sem o nome do repositório) e rode `npm run deploy` de novo.
4. Salve (*commit*). O GitHub publica as telas novamente em cerca de 1 minuto.

---

## Parte 4 — Primeiro uso

1. Abra o endereço do GitHub Pages no celular.
2. Toque em **"Entrar como administrador do sistema"** e entre com o acesso criado na etapa 2.6.
3. Para cadastrar o primeiro lava-jato: saia, volte à tela de login, toque em **"Solicitar acesso"**, preencha os dados do lava-jato e envie.
4. Entre de novo como administrador do sistema, abra **Clientes → Pendentes** e toque em **Autorizar**.
5. O responsável entra com o e-mail e a senha que cadastrou, vai em **Mais → Serviços** e **Mais → Produtos e estoque** para cadastrar o básico, e em **Mais → Usuários** para criar quem faz os lançamentos do dia.

### Instalar como aplicativo
- **Android (Chrome):** menu ⋮ → **Instalar aplicativo** (ou **Adicionar à tela inicial**).
- **iPhone (Safari):** botão de compartilhar → **Adicionar à Tela de Início**.

---

> **Ponto de atenção no primeiro login:** o login faz um cálculo de senha mais pesado que as demais telas. Ele funcionou nos testes, mas o limite de processamento do plano gratuito só pode ser confirmado na Cloudflare de verdade. Por isso, **faça o primeiro login logo depois de publicar** e, se der erro, veja a última linha da tabela "Se algo der errado".

## Checklist de teste no celular

Faça com o celular de verdade, de preferência com internet móvel:

- [ ] A tela de login abre e o app pode ser instalado na tela inicial.
- [ ] **Solicitar acesso** funciona e o lava-jato aparece em **Clientes → Pendentes**.
- [ ] Autorizar libera o login; **Bloquear** derruba o acesso na hora.
- [ ] Lançar uma receita leva poucos toques e aparece no **Caixa** e no **Início**.
- [ ] Lançar uma despesa com categoria e forma de pagamento.
- [ ] Cancelar um lançamento (administrador) pede motivo e tira o valor dos totais.
- [ ] Um **operador** consegue lançar, mas não vê custos, **Análise** nem **Usuários**.
- [ ] A tela **Análise** mostra gráficos e o ponto de equilíbrio.
- [ ] **Mais → Auditoria** mostra quem fez cada ação.
- [ ] Nenhuma tela rola para o lado; os botões são fáceis de tocar.
- [ ] Com o celular em **modo avião**, o app abre e mostra aviso de erro de conexão (não trava).

---

## Se algo der errado

| Sintoma | O que fazer |
|---|---|
| A tela de login mostra "Sem conexão com o servidor" | Confira o endereço em `frontend/js/config.js` (termina em `/api`) e abra `.../api/health` no navegador. |
| Erro de CORS no console / "Forbidden" ao entrar | O endereço do GitHub Pages precisa estar em `ALLOWED_ORIGINS` (`worker/wrangler.toml`). Depois rode `npm run deploy`. |
| A tela não atualiza depois de mudar o código | Feche e abra o app. O aviso **"Nova versão disponível"** aparece e basta tocar em **Atualizar**. |
| Entrar dá erro 500 ou "Worker exceeded CPU time limit" (erro 1102) no painel da Cloudflare | A verificação de senha é propositalmente pesada (é o que protege as senhas) e o plano gratuito limita o processamento por requisição. **Avise o Claude**: as saídas são reduzir o custo do cálculo da senha (um pouco menos de proteção contra quebra de senha) ou assinar o plano pago do Workers (cerca de US$ 5 por mês). Não altere nada por conta própria. |
| Esqueci a senha de administrador do sistema | Rode de novo `npm run create-system-admin` e o `d1 execute` da etapa 2.6 com o mesmo e-mail: a senha é redefinida. |
| `npm run deploy` pede login | Rode `npx wrangler login` de novo. |

## Custos e limites (plano gratuito)

O uso de um lava-jato fica muito abaixo dos limites gratuitos da Cloudflare (100 mil requisições por dia no Workers, 5 GB no D1). Se um dia o volume crescer muito, a Cloudflare avisa antes de cobrar qualquer coisa.
