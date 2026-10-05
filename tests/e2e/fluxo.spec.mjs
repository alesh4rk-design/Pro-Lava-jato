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
  await expect(operator.locator('.menu-link:visible')).toHaveText(['Produtos e estoque', 'Serviços']);
  for (const page of ['usuarios.html', 'categorias.html', 'auditoria.html', 'configuracoes.html']) {
    await operator.goto(page);
    await operator.waitForURL(/dashboard\.html/);
  }
  await operator.goto('analise.html');
  await expect(operator.locator('#analysis')).toContainText('apenas para o administrador');
  await operator.goto('produtos.html');
  await expect(operator.locator('#product-list')).not.toContainText('Custo');

  // A interface esconde; quem bloqueia é a API.
  const status = await operator.evaluate(async () => {
    const { token } = JSON.parse(localStorage.getItem('lj.session'));
    const r = await fetch('http://127.0.0.1:8787/api/reports/financial', { headers: { Authorization: `Bearer ${token}` } });
    return r.status;
  });
  expect(status).toBe(403);
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
