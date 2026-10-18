// Fluxo completo do app em tela de celular (360px), com API e banco reais.
// Os testes rodam em sequência e compartilham o mesmo lava-jato.

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const SYSTEM = { email: 'admin@sistema.test', password: 'Admin12345' };
const OWNER = { email: 'maria@central.test', password: 'Lava12345', business: 'Lava Rápido Central' };
const OPERATOR = { email: 'joao@central.test', password: 'Opera1234' };
const NEW_PASSWORD = 'NovaSenha789';

// Erros de console esperados: respostas 400/403/409 dos testes de senha errada, bloqueio e estoque insuficiente.
const EXPECTED_ERRORS = /status of (400|403|409)/;

/** Abre uma página que falha o teste se houver erro inesperado no console ou na página. */
async function openPage(browser, playwright) {
  const context = await browser.newContext({ ...playwright.devices['Pixel 5'], viewport: { width: 360, height: 760 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' && !EXPECTED_ERRORS.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  page.problems = problems;
  return page;
}

async function login(page, { email, password }, { system = false } = {}) {
  await page.goto('login.html');
  if (system) await page.click('#toggle-system');
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await page.click('#login-submit');
  await page.waitForURL(system ? /admin\.html/ : /dashboard\.html/);
}

const lastToast = (page) => page.locator('.toast').last();
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

let owner;
let operator;

test.beforeAll(async ({ browser, playwright }) => {
  owner = await openPage(browser, playwright);
  operator = await openPage(browser, playwright);
});

test.afterAll(() => {
  expect(owner.problems, 'erros no console (dono)').toEqual([]);
  expect(operator.problems, 'erros no console (operador)').toEqual([]);
});

test('solicitação de acesso, autorização e primeiro login', async ({ browser, playwright }) => {
  await owner.goto('login.html');
  await owner.click('#show-request');
  await owner.fill('#req-business', OWNER.business);
  await owner.fill('#req-owner', 'Maria Souza');
  await owner.fill('#req-email', OWNER.email);
  await owner.fill('#req-password', OWNER.password);
  await owner.fill('#req-password2', OWNER.password);
  await owner.click('#request-submit');
  await expect(owner.locator('#form-alert')).toContainText('Solicitação enviada');

  await owner.fill('#login-email', OWNER.email);
  await owner.fill('#login-password', OWNER.password);
  await owner.click('#login-submit');
  await expect(owner.locator('#form-alert')).toContainText('ainda não foi autorizado');

  const system = await openPage(browser, playwright);
  await login(system, SYSTEM, { system: true });
  await system.locator('.tenant-card', { hasText: OWNER.business }).locator('.btn-success').click();
  await system.click('dialog .btn-primary');
  await expect(lastToast(system)).toContainText('Acesso autorizado');
  await system.goto('admin-auditoria.html');
  await expect(system.locator('.audit-row').first()).toContainText(`Autorizou o acesso de ${OWNER.business}`);
  expect(system.problems).toEqual([]);

  await login(owner, OWNER);
  await expect(owner.locator('.app-header-title strong')).toHaveText(OWNER.business);
});

test('cadastro de operador, produto e serviço com custo', async () => {
  await owner.goto('usuarios.html');
  await owner.click('#new-user');
  await owner.fill('#u-name', 'João Operador');
  await owner.fill('#u-email', OPERATOR.email);
  await owner.fill('#u-password', OPERATOR.password);
  await owner.click('dialog .btn-primary');
  await expect(owner.locator('.user-card', { hasText: 'João Operador' })).toBeVisible();

  await owner.goto('produtos.html');
  await owner.click('#new-product');
  await owner.fill('#p-name', 'Shampoo');
  await owner.fill('#p-min', '2');
  await owner.click('dialog .btn-primary');
  await expect(owner.locator('.user-card', { hasText: 'Shampoo' })).toContainText('Sem estoque');

  // Compra de 5 L por R$ 85,00 → R$ 17,00/L, com a despesa lançada no caixa
  await owner.goto('lancamento.html');
  await owner.click('#new-stock');
  await owner.click('dialog .chip:has-text("Shampoo")');
  await owner.fill('#mv-qty', '5');
  await owner.fill('#mv-total', '85,00');
  await owner.click('dialog .modal-actions .btn-primary');
  await expect(owner.locator('.toast', { hasText: 'Compra registrada' })).toContainText('Despesa de R$');

  await owner.goto('servicos.html');
  await owner.click('#new-service');
  await owner.fill('#s-name', 'Lavagem completa');
  await owner.fill('#s-price', '70,00');
  await owner.click('dialog button:has-text("Produto")');
  await owner.locator('dialog .cost-row input[aria-label="Quantidade"]').fill('100');
  await owner.click('dialog button:has-text("Custo rateado")');
  await owner.locator('dialog .cost-row input[aria-label="Descrição do custo"]').fill('Água');
  await owner.locator('dialog .cost-row input[aria-label="Valor"]').fill('2,00');
  await expect(owner.locator('.cost-summary')).toContainText('Custo estimado R$ 3,70');
  await owner.click('dialog .modal-actions .btn-primary');
  await expect(owner.locator('.user-card', { hasText: 'Lavagem completa' })).toContainText('margem R$ 66,30');
});

test('lançamentos rápidos, caixa e cancelamento', async () => {
  await owner.goto('lancamento.html?tipo=receita');
  await owner.click('dialog .chip:has-text("Lavagem completa")');
  await expect(owner.locator('#revenue-amount')).toHaveValue('70,00');
  await owner.click('dialog .btn-success');
  await expect(lastToast(owner)).toContainText('Receita de R$ 70,00 registrada');

  await owner.goto('lancamento.html?tipo=despesa');
  await owner.fill('#expense-amount', '2.500');
  await owner.click('dialog .chip:has-text("Aluguel")');
  await expect(owner.locator('dialog [aria-label="Tipo"] .chip[aria-pressed="true"]')).toHaveText('Despesa fixa');
  await owner.click('dialog .btn-danger');
  await expect(lastToast(owner)).toContainText('Despesa de R$ 2.500,00 registrada');

  // Validação no cliente: valor negativo não é enviado
  await owner.goto('lancamento.html?tipo=despesa');
  await owner.fill('#expense-amount', '-50');
  await owner.click('dialog .btn-danger');
  await expect(owner.locator('#expense-amount-error')).toContainText('maior que zero');

  await owner.goto('caixa.html');
  await expect(owner.locator('.cash-totals')).toContainText('Entradas');
  await expect(owner.locator('.cash-balance')).toContainText('-R$ 2.515,00'); // 70 − 85 − 2.500

  await owner.locator('.entry-row.is-out', { hasText: 'Aluguel' }).click();
  await owner.click('dialog .btn-outline:has-text("Cancelar")');
  await owner.fill('#cancel-reason', 'Lançado errado');
  await owner.click('dialog .btn-danger');
  await expect(lastToast(owner)).toContainText('Lançamento cancelado');
  await expect(owner.locator('.cash-balance')).toContainText('-R$ 15,00');
});

test('análise, ponto de equilíbrio e auditoria', async () => {
  await owner.goto('analise.html');
  await expect(owner.locator('#analysis .section-title')).toHaveCount(6);
  await owner.waitForFunction(() => window.Chart && [...document.querySelectorAll('#analysis canvas')].every((c) => window.Chart.getChart(c)));
  await expect(owner.locator('#analysis')).toContainText('Ponto de equilíbrio');

  await owner.goto('auditoria.html');
  await expect(owner.locator('.audit-row', { hasText: 'Cancelou despesa de R$ 2.500,00 — motivo: Lançado errado' })).toBeVisible();
  // Ações do administrador do sistema (autorizar etc.) nunca aparecem para o lava-jato.
  await expect(owner.locator('#audit-list')).not.toContainText('Autorizou');
  await owner.click('#group-chips [data-group="ACESSOS"]');
  await expect(owner.locator('.audit-row').first()).toContainText('Entrou no sistema');
});

test('configurações: alterar o nome atualiza o topo e a auditoria', async () => {
  await owner.goto('configuracoes.html');
  await expect(owner.locator('#s-name')).toHaveValue(OWNER.business);
  await owner.fill('#s-name', 'Brilho Central');
  await owner.fill('#s-phone', '11988887777');
  await owner.click('#s-save');
  await expect(lastToast(owner)).toContainText('Configurações salvas');
  await expect(owner.locator('.app-header-title strong')).toHaveText('Brilho Central');
  await owner.reload();
  await expect(owner.locator('.app-header-title strong')).toHaveText('Brilho Central');
  await expect(owner.locator('#s-phone')).toHaveValue('(11) 98888-7777');

  await owner.fill('#s-name', 'A');
  await owner.click('#s-save');
  await expect(owner.locator('#s-name-error')).toContainText('Informe o nome');

  await owner.goto('auditoria.html');
  await expect(owner.locator('.audit-row', { hasText: 'Alterou as configurações do lava-jato' })).toContainText('nome do lava-jato');
});

test('operador: lança, mas não vê custos nem áreas do administrador', async () => {
  await login(operator, OPERATOR);
  await operator.goto('lancamento.html?tipo=receita');
  await operator.click('dialog .chip:has-text("Lavagem completa")');
  await operator.click('dialog .btn-success');
  await expect(lastToast(operator)).toContainText('registrada');

  await operator.goto('mais.html');
  await expect(operator.locator('.menu-link:visible')).toHaveText(['Clientes e mensagens', 'Produtos e estoque', 'Serviços']);
  for (const page of ['usuarios.html', 'categorias.html', 'auditoria.html', 'configuracoes.html', 'caixa.html', 'analise.html', 'recorrentes.html']) {
    await operator.goto(page);
    await operator.waitForURL(/dashboard\.html/);
  }
  await operator.goto('produtos.html');
  await expect(operator.locator('#product-list')).not.toContainText('Custo');

  // Menu enxuto: Início, Lançar e Mais (sem Caixa e sem Análise)
  await expect(operator.locator('.bottom-nav .nav-item')).toHaveText(['Início', 'Lançar', 'Mais']);

  // Início do operador: só o que ele mesmo lançou hoje, sem totais do lava-jato
  await operator.goto('dashboard.html');
  await expect(operator.locator('#dash-content')).toContainText('Seus lançamentos de hoje');
  await expect(operator.locator('#dash-content .entry-row')).toHaveCount(1);
  await expect(operator.locator('#dash-content')).toContainText('+R$ 70,00');
  for (const hidden of ['Resultado do período', 'Faturamento', 'Margem', 'Despesas', 'Saldo']) await expect(operator.locator('main')).not.toContainText(hidden);
  await expect(operator.locator('#period-chips')).toBeHidden();
  await operator.locator('#dash-content .entry-row').click();
  await expect(operator.locator('dialog[open]')).toContainText('Receita');
  await expect(operator.locator('dialog[open]')).not.toContainText('Custo estimado');
  await operator.click('dialog[open] button[aria-label="Fechar"]');

  // A interface esconde; quem bloqueia é a API.
  const statuses = await operator.evaluate(async () => {
    const { token } = JSON.parse(localStorage.getItem('lj.session'));
    const get = async (path) => (await fetch(`http://127.0.0.1:8787/api${path}`, { headers: { Authorization: `Bearer ${token}` } })).status;
    return Promise.all(['/reports/financial', '/dashboard?period=month', '/cash?period=month', '/cash/entries?period=month', '/revenues', '/expenses'].map(get));
  });
  expect(statuses).toEqual([403, 403, 403, 403, 403, 403]);
});

test('nenhuma tela rola para o lado em 360px', async () => {
  const pages = ['dashboard', 'caixa', 'lancamento', 'analise', 'mais', 'produtos', 'servicos', 'categorias', 'usuarios', 'auditoria', 'configuracoes'];
  for (const name of pages) {
    await owner.goto(`${name}.html`);
    await owner.waitForLoadState('networkidle');
    expect(await noHorizontalScroll(owner), name).toBe(true);
  }
  await owner.goto('lancamento.html?tipo=receita');
  await expect(owner.locator('dialog[open]')).toBeVisible();
  expect(await noHorizontalScroll(owner), 'formulário de receita').toBe(true);
});

test('esqueci minha senha, senha errada e troca de senha pelo Firebase', async ({ browser, playwright }) => {
  const visitor = await openPage(browser, playwright);
  await visitor.goto('login.html');
  await visitor.fill('#login-email', OWNER.email);
  await visitor.fill('#login-password', 'senhaErrada1');
  await visitor.click('#login-submit');
  await expect(visitor.locator('#form-alert')).toContainText('E-mail ou senha inválidos');

  await visitor.click('#forgot');
  await expect(visitor.locator('#form-alert')).toContainText('enviamos um link');

  // Dono troca a própria senha em Conta → Trocar senha.
  await owner.goto('dashboard.html');
  await owner.click('button[aria-label="Conta"]');
  await owner.click('dialog button:has-text("Trocar senha")');
  await owner.fill('#p-current', OWNER.password);
  await owner.fill('#p-new', NEW_PASSWORD);
  await owner.fill('#p-confirm', NEW_PASSWORD);
  await owner.click('dialog .btn-primary');
  await expect(lastToast(owner)).toContainText('Senha alterada');

  // A senha antiga deixa de valer e a nova entra.
  await visitor.fill('#login-password', OWNER.password);
  await visitor.click('#login-submit');
  await expect(visitor.locator('#form-alert')).toContainText('E-mail ou senha inválidos');
  await login(visitor, { email: OWNER.email, password: NEW_PASSWORD });
  expect(visitor.problems).toEqual([]);

  // Administrador do lava-jato manda o e-mail de redefinição ao operador.
  await owner.goto('usuarios.html');
  await owner.locator('.user-card', { hasText: 'João Operador' }).click();
  await owner.click('dialog button:has-text("Redefinir senha")');
  await owner.click('dialog button:has-text("Enviar e-mail")');
  await expect(lastToast(owner)).toContainText('E-mail de redefinição enviado');
});

test('navegação: voltar, editar o próprio nome e selos de edição', async ({ browser, playwright }) => {
  await owner.goto('categorias.html');
  await expect(owner.locator('.user-card').first().locator('.edit-chip')).toHaveText('Editar');
  await owner.click('.header-back');
  await owner.waitForURL(/mais\.html/);

  await owner.click('button[aria-label="Conta"]');
  await owner.click('#edit-my-name');
  await owner.fill('#my-name', 'Maria Souza Lima');
  await owner.click('dialog[open] .btn-primary');
  await expect(lastToast(owner)).toContainText('Nome atualizado');
  await owner.reload();
  await owner.click('button[aria-label="Conta"]');
  await expect(owner.locator('dialog[open]')).toContainText('Maria Souza Lima');
  await owner.click('dialog[open] button[aria-label="Fechar"]');

  // Administrador do sistema corrige o nome do cliente; isso não aparece na auditoria do lava-jato.
  const system = await openPage(browser, playwright);
  await login(system, SYSTEM, { system: true });
  await system.click('#status-chips .chip:has-text("Ativos")');
  await system.locator('.tenant-card', { hasText: 'Brilho Central' }).locator('.tenant-edit').click();
  await system.fill('#t-name', 'Brilho Central Lava-Jato');
  await system.click('dialog[open] .btn-primary');
  await expect(lastToast(system)).toContainText('Dados do cliente atualizados');
  expect(system.problems).toEqual([]);

  await owner.goto('auditoria.html');
  await expect(owner.locator('.audit-row', { hasText: 'Alterou o próprio nome' })).toBeVisible();
  await expect(owner.locator('#audit-list')).not.toContainText('Editou os dados');
});

test('despesas recorrentes: cadastrar, lançar na hora, alerta de vencimento e pausar', async () => {
  await owner.goto('mais.html');
  await owner.click('a.menu-link:has-text("Despesas recorrentes")');
  await owner.waitForURL(/recorrentes\.html/);
  await expect(owner.locator('.state')).toContainText('Nenhuma despesa recorrente');

  // Diária começando hoje: o primeiro lançamento acontece na hora.
  await owner.click('#new-recurring');
  await owner.fill('#r-amount', '30,00');
  await owner.fill('#r-description', 'Lanche da equipe');
  await owner.click('dialog .chip:has-text("Aluguel")');
  await owner.click('dialog .chip:has-text("Diária")');
  await owner.click('dialog .modal-actions .btn-primary');
  await expect(lastToast(owner)).toContainText('Despesa recorrente criada');
  const card = owner.locator('.recurring-card', { hasText: 'Lanche da equipe' });
  await expect(card).toContainText('Todo dia');
  await expect(card).toContainText('Próximo lançamento');

  // Semanal no dia de amanhã: aparece como "amanhã" no aviso do Início.
  const tomorrow = await owner.evaluate(() => (new Date().getDay() + 1) % 7);
  await owner.click('#new-recurring');
  await owner.fill('#r-amount', '150,00');
  await owner.fill('#r-description', 'Diarista');
  await owner.click('dialog .chip:has-text("Aluguel")');
  await owner.click('dialog .chip:has-text("Semanal")');
  await owner.locator('dialog [aria-label="Dia da semana"] .chip').nth(tomorrow).click();
  await owner.click('dialog .modal-actions .btn-primary');
  await expect(owner.locator('.recurring-card', { hasText: 'Diarista' })).toContainText('Toda ');

  await owner.goto('dashboard.html');
  await expect(owner.locator('#due-alert')).toBeVisible();
  await expect(owner.locator('#due-alert')).toContainText('Vencimentos para hoje ou amanhã');
  await expect(owner.locator('#due-alert')).toContainText('Diarista');
  await expect(owner.locator('#due-alert')).toContainText('amanhã');

  // O lançamento automático está no Caixa e informa a origem.
  await owner.goto('caixa.html');
  await owner.locator('.entry-row.is-out', { hasText: 'Lanche da equipe' }).click();
  await expect(owner.locator('dialog[open]')).toContainText('Despesa recorrente (lançamento automático)');
  await owner.click('dialog[open] button[aria-label="Fechar"]');

  // Pausar tira do aviso; o operador não vê nada disso.
  await owner.goto('recorrentes.html');
  await owner.locator('.recurring-card', { hasText: 'Diarista' }).locator('button:has-text("Pausar")').click();
  await expect(owner.locator('.recurring-card', { hasText: 'Diarista' })).toContainText('Pausada');
  await owner.goto('dashboard.html');
  await expect(owner.locator('#due-alert')).not.toContainText('Diarista');

  await operator.goto('dashboard.html');
  await expect(operator.locator('#due-alert')).toBeHidden();
  await operator.goto('recorrentes.html');
  await operator.waitForURL(/dashboard\.html/);
  expect(await noHorizontalScroll(owner), 'recorrentes').toBe(true);
});

test('categoria de despesa criada na hora do lançamento (só administrador)', async () => {
  await owner.goto('lancamento.html?tipo=despesa');
  await owner.fill('#expense-amount', '180,00');
  await owner.click('dialog button:has-text("+ Nova categoria")');
  await owner.fill('#nc-name', 'Energia elétrica');
  await owner.click('dialog[open]:has-text("Nova categoria de despesa") .btn-primary');
  await expect(lastToast(owner)).toContainText('Categoria criada');
  await expect(owner.locator('dialog [aria-label="Categoria"] .chip[aria-pressed="true"]')).toHaveText('Energia elétrica');
  await owner.click('dialog .btn-danger');
  await expect(lastToast(owner)).toContainText('Despesa de R$ 180,00 registrada');

  await operator.goto('lancamento.html?tipo=despesa');
  await expect(operator.locator('dialog[open]')).toBeVisible();
  await expect(operator.locator('dialog button:has-text("+ Nova categoria")')).toHaveCount(0);
});

test('clientes e mensagens prontas para WhatsApp', async () => {
  await owner.goto('mais.html');
  await owner.click('a.menu-link:has-text("Clientes e mensagens")');
  await owner.waitForURL(/clientes\.html/);
  await expect(owner.locator('.state')).toContainText('Nenhum cliente cadastrado');

  await owner.click('#new-item');
  await owner.fill('#c-name', 'João da Silva');
  await owner.fill('#c-phone', '21977665544');
  await owner.fill('#c-vehicle', 'Gol branco');
  await owner.fill('#c-plate', 'abc-1d23');
  await owner.click('dialog .btn-primary');
  const card = owner.locator('.customer-card', { hasText: 'João da Silva' });
  await expect(card).toContainText('(21) 97766-5544');
  await expect(card).toContainText('Gol branco · ABC1D23');
  await expect(card).toContainText('Ainda sem contato');

  // Busca por placa
  await owner.fill('#customer-search', 'abc1d');
  await expect(owner.locator('.customer-card')).toHaveCount(1);
  await owner.fill('#customer-search', 'zzzz');
  await expect(owner.locator('.state')).toContainText('Nenhum cliente encontrado');
  await owner.fill('#customer-search', '');

  // Mensagem pronta: o texto vem preenchido e o link do WhatsApp é montado (sem enviar nada sozinho)
  await owner.evaluate(() => { window.__opened = []; window.open = (url) => { window.__opened.push(url); return null; }; });
  await owner.locator('.customer-card', { hasText: 'João da Silva' }).locator('button:has-text("WhatsApp")').click();
  await expect(owner.locator('#send-text')).toHaveValue(/Olá, João da Silva! A limpeza do seu veículo \(Gol branco · ABC1D23\) já foi concluída/);
  await owner.click('dialog .chip:has-text("Agradecimento")');
  await expect(owner.locator('#send-text')).toHaveValue(/Obrigado por escolher o Brilho Central/);
  await owner.click('dialog .chip:has-text("Veículo pronto")');
  await owner.click('dialog .btn-success');
  const opened = await owner.evaluate(() => window.__opened);
  expect(opened).toHaveLength(1);
  const url = new URL(opened[0]);
  expect(url.origin + url.pathname).toBe('https://wa.me/5521977665544');
  expect(url.searchParams.get('text')).toContain('já foi concluída');
  await owner.reload();
  await expect(owner.locator('.customer-card', { hasText: 'João da Silva' })).toContainText('Último contato:');

  // O administrador edita uma mensagem pronta e cria outra, com prévia
  await owner.click('#tabs [data-tab="mensagens"]');
  await expect(owner.locator('#template-list .card')).toHaveCount(6);
  await owner.click('#new-item');
  await owner.fill('#t-title', 'Aviso de horário');
  await owner.fill('#t-body', 'Olá, {nome}! Hoje fechamos às 18h.');
  await expect(owner.locator('.message-preview')).toHaveText('Olá, Carlos Silva! Hoje fechamos às 18h.');
  await owner.click('dialog .btn-primary');
  await expect(owner.locator('#template-list .card')).toHaveCount(7);

  // Operador cadastra e envia, mas não gerencia as mensagens
  await operator.goto('clientes.html');
  await expect(operator.locator('#tabs [data-tab="mensagens"]')).toBeHidden();
  await expect(operator.locator('.customer-card', { hasText: 'João da Silva' })).toBeVisible();
  await operator.locator('.customer-card', { hasText: 'João da Silva' }).locator('button:has-text("WhatsApp")').click();
  await expect(operator.locator('dialog [aria-label="Mensagens prontas"] .chip')).toHaveCount(7);
  await operator.click('dialog button:has-text("Cancelar")');

  // Auditoria registra sem telefone
  await owner.goto('auditoria.html');
  await expect(owner.locator('.audit-row', { hasText: 'Abriu o WhatsApp para João da Silva' })).toContainText('Veículo pronto');
  await expect(owner.locator('#audit-list')).not.toContainText('977665544');
  expect(await noHorizontalScroll(owner), 'auditoria').toBe(true);
});

test('chave PIX: cadastro em Configurações e mensagem pronta com a chave', async () => {
  // Sem chave cadastrada, a mensagem avisa e não deixa enviar sem escrever a chave
  await owner.goto('clientes.html');
  await owner.evaluate(() => { window.__opened = []; window.open = (url) => { window.__opened.push(url); return null; }; });
  await owner.locator('.customer-card', { hasText: 'João da Silva' }).locator('button:has-text("WhatsApp")').click();
  await owner.click('dialog .chip:has-text("Chave PIX")');
  await expect(owner.locator('#send-text')).toHaveValue(/\[cadastre a chave PIX em Configurações\]/);
  await expect(owner.locator('.pix-warning')).toBeVisible();
  await owner.click('dialog .btn-success');
  await expect(lastToast(owner)).toContainText('chave PIX ainda não foi cadastrada');
  expect(await owner.evaluate(() => window.__opened.length)).toBe(0);
  await owner.click('dialog button:has-text("Cancelar")');

  // Cadastro com validação
  await owner.goto('configuracoes.html');
  await expect(owner.locator('.pix-status')).toContainText('Nenhuma chave cadastrada');
  await owner.fill('#pix-key', '123.456.789-00');
  await owner.click('#pix-save');
  await expect(owner.locator('#pix-key-error')).toContainText('CPF incorreto');
  await owner.fill('#pix-key', '529.982.247-25');
  await owner.fill('#pix-holder', 'Brilho Central Ltda');
  await owner.click('#pix-save');
  await expect(lastToast(owner)).toContainText('Chave PIX salva');
  await expect(owner.locator('.pix-status')).toContainText('529.982.247-25');

  // A mensagem agora leva a chave e o recebedor; o operador também usa
  await owner.goto('clientes.html');
  await owner.evaluate(() => { window.__opened = []; window.open = (url) => { window.__opened.push(url); return null; }; });
  await owner.locator('.customer-card', { hasText: 'João da Silva' }).locator('button:has-text("WhatsApp")').click();
  await owner.click('dialog .chip:has-text("Chave PIX")');
  await expect(owner.locator('#send-text')).toHaveValue(/52998224725\nRecebedor: Brilho Central Ltda/);
  await owner.click('dialog .btn-success');
  const sent = new URL(await owner.evaluate(() => window.__opened[0]));
  expect(sent.searchParams.get('text')).toContain('52998224725');
  await operator.goto('clientes.html');
  await operator.locator('.customer-card', { hasText: 'João da Silva' }).locator('button:has-text("WhatsApp")').click();
  await operator.click('dialog .chip:has-text("Chave PIX")');
  await expect(operator.locator('#send-text')).toHaveValue(/52998224725/);
  await operator.click('dialog button:has-text("Cancelar")');

  // Trocar pede confirmação; a auditoria guarda só o final da chave
  await owner.goto('configuracoes.html');
  await owner.click('[aria-label="Tipo da chave"] .chip:has-text("E-mail")');
  await owner.fill('#pix-key', 'Pagar@Brilho.com.br');
  await owner.click('#pix-save');
  await expect(owner.locator('dialog[open]')).toContainText('Trocar a chave PIX?');
  await owner.click('dialog .btn-primary');
  await expect(owner.locator('.pix-status')).toContainText('pagar@brilho.com.br');
  await owner.goto('auditoria.html');
  await expect(owner.locator('.audit-row', { hasText: 'chave PIX' }).first()).toContainText('••••');
  await expect(owner.locator('#audit-list')).not.toContainText('52998224725');
  await expect(owner.locator('#audit-list')).not.toContainText('pagar@brilho.com.br');

  // Remover a chave
  await owner.goto('configuracoes.html');
  await owner.click('#pix-remove');
  await owner.click('dialog .btn-danger');
  await expect(owner.locator('.pix-status')).toContainText('Nenhuma chave cadastrada');
  expect(await noHorizontalScroll(owner), 'configurações').toBe(true);
});

test('usuários: só operadores e no máximo 2 por lava-jato', async () => {
  await owner.goto('usuarios.html');
  await expect(owner.locator('#limit-hint')).toContainText('Operadores ativos: 1 de 2');
  await owner.click('#new-user');
  await expect(owner.locator('dialog[open] input[name="role"]')).toHaveCount(0); // não há escolha de perfil
  await expect(owner.locator('dialog[open]')).toContainText('entra como operador');
  await owner.fill('#u-name', 'Ana Operadora');
  await owner.fill('#u-email', 'ana@central.test');
  await owner.fill('#u-password', 'Opera5678');
  await owner.click('dialog .btn-primary');
  await expect(owner.locator('.user-card', { hasText: 'Ana Operadora' })).toBeVisible();
  await expect(owner.locator('#limit-hint')).toContainText('2 de 2');

  // Terceiro operador: recusado antes mesmo de criar a conta
  await owner.click('#new-user');
  await expect(lastToast(owner)).toContainText('Limite de 2 operadores atingido');
  await expect(owner.locator('dialog[open]')).toHaveCount(0);

  // Editar: o perfil aparece só como informação; desativar libera a vaga
  await owner.locator('.user-card', { hasText: 'Ana Operadora' }).click();
  await expect(owner.locator('dialog[open] input[name="role"]')).toHaveCount(0);
  await expect(owner.locator('dialog[open]')).toContainText('O perfil não pode ser alterado');
  await owner.locator('dialog[open] label.switch').click();
  await owner.click('dialog[open] .btn-primary');
  await owner.click('dialog[open] .btn-danger');
  await expect(lastToast(owner)).toContainText('Usuário atualizado');
  await expect(owner.locator('#limit-hint')).toContainText('1 de 2');

  // Reativar quando já há 2 ativos não passa do limite; aqui há vaga, então reativa
  await owner.locator('.user-card', { hasText: 'Ana Operadora' }).click();
  await owner.locator('dialog[open] label.switch').click();
  await owner.click('dialog[open] .btn-primary');
  await expect(lastToast(owner)).toContainText('Usuário atualizado');
  await expect(owner.locator('#limit-hint')).toContainText('2 de 2');

  // A API também recusa quem tentar contornar a tela
  const result = await owner.evaluate(async () => {
    const { token } = JSON.parse(localStorage.getItem('lj.session'));
    const r = await fetch('http://127.0.0.1:8787/api/users', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Intruso', id_token: 'x', role: 'ADMIN' }) });
    return { status: r.status, body: await r.json() };
  });
  expect(result.status).toBe(400);
  expect(result.body.error.message).toBe('Só é possível cadastrar operadores.');
});

test('receita com o cliente que fez a limpeza: cadastro na hora, busca e histórico', async () => {
  // Cliente novo, cadastrado na hora do lançamento
  await owner.goto('lancamento.html?tipo=receita');
  await owner.click('dialog .chip:has-text("Lavagem completa")');
  await owner.fill('#customer-pick', 'Maria');
  await owner.click('dialog .chip-new');
  await expect(owner.locator('#qc-name')).toHaveValue('Maria');
  await owner.fill('#qc-name', 'Maria Teste');
  await owner.fill('#qc-phone', '31 98888-1212');
  await owner.fill('#qc-plate', 'xyz-9k88');
  await owner.click('dialog:has-text("Novo cliente") .btn-primary');
  await expect(owner.locator('.customer-name')).toHaveText('Maria Teste');
  await expect(owner.locator('#revenue-amount')).toHaveValue('70,00');
  await owner.click('dialog .btn-success');
  await expect(lastToast(owner)).toContainText('Receita de R$ 70,00 registrada');

  // O nome aparece no caixa e no detalhe
  await owner.goto('caixa.html');
  const row = owner.locator('.entry-row.is-in', { hasText: 'Maria Teste' });
  await expect(row).toBeVisible();
  await row.click();
  await expect(owner.locator('dialog[open]')).toContainText('Cliente');
  await expect(owner.locator('dialog[open]')).toContainText('Maria Teste');
  await owner.click('dialog[open] button[aria-label="Fechar"]');
  await owner.fill('#cash-search', 'maria teste');
  await expect(owner.locator('.entry-row')).toHaveCount(1);

  // Operador escolhe um cliente que já existe e vê o nome no "Meu dia"
  await operator.goto('lancamento.html?tipo=receita');
  await operator.click('dialog .chip:has-text("Lavagem completa")');
  await operator.fill('#customer-pick', 'abc1d');
  await operator.click('dialog .customer-results .chip:has-text("João da Silva")');
  await operator.click('dialog .btn-success');
  await expect(lastToast(operator)).toContainText('registrada');
  await operator.goto('dashboard.html');
  await expect(operator.locator('#dash-content .entry-row', { hasText: 'João da Silva' })).toBeVisible();

  // Histórico no cadastro: o administrador vê o total; o operador, não
  await owner.goto('clientes.html');
  const maria = owner.locator('.customer-card', { hasText: 'Maria Teste' });
  await expect(maria).toContainText('1 lavagem · última em');
  await expect(maria).toContainText('total R$ 70,00');
  await operator.goto('clientes.html');
  await expect(operator.locator('.customer-card', { hasText: 'Maria Teste' })).toContainText('1 lavagem');
  await expect(operator.locator('.customer-card', { hasText: 'Maria Teste' })).not.toContainText('total');

  // Trocar e remover o cliente de uma receita (administrador)
  await owner.goto('caixa.html');
  await owner.locator('.entry-row.is-in', { hasText: 'Maria Teste' }).click();
  await owner.click('dialog[open] button:has-text("Editar")');
  await expect(owner.locator('.customer-name')).toHaveText('Maria Teste');
  await owner.click('dialog[open] button:has-text("Remover")');
  await owner.click('dialog[open] .btn-success');
  await expect(lastToast(owner)).toContainText('atualizada');
  await expect(owner.locator('.entry-row.is-in', { hasText: 'Maria Teste' })).toHaveCount(0);
});

test('telas novas não rolam para o lado em 360px', async () => {
  for (const name of ['clientes', 'recorrentes']) {
    await owner.goto(`${name}.html`);
    await owner.waitForLoadState('networkidle');
    expect(await noHorizontalScroll(owner), name).toBe(true);
  }
  await owner.goto('clientes.html');
  await owner.locator('.customer-card').first().locator('button:has-text("WhatsApp")').click();
  await expect(owner.locator('dialog[open]')).toBeVisible();
  expect(await noHorizontalScroll(owner), 'envio de mensagem').toBe(true);

  // Formulário de receita com a lista de clientes aberta: nada pode passar da largura da tela
  const dialogFits = () => owner.evaluate(() => { const d = document.querySelector('dialog[open]'); return d.scrollWidth <= d.clientWidth; });
  await owner.goto('lancamento.html?tipo=receita');
  await expect(owner.locator('dialog[open]')).toBeVisible();
  await owner.fill('#customer-pick', 'a');
  await expect(owner.locator('.customer-results .chip').first()).toBeVisible();
  expect(await noHorizontalScroll(owner), 'receita com clientes').toBe(true);
  expect(await dialogFits(), 'janela da receita com clientes').toBe(true);
});
