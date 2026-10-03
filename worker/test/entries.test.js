import { describe, it, expect } from 'vitest';
import { call, financeFixture, seedTenant, seedCategory, seedService, login, env, todayIso } from './helpers.js';
import { addDays } from '../src/lib/dates.js';

const revenue = (f, extra = {}) => ({ date: todayIso(), service_id: f.serviceId, amount_cents: 7000, payment_method: 'PIX', ...extra });
const expense = (f, extra = {}) => ({ date: todayIso(), category_id: f.categoryId, amount_cents: 250000, payment_method: 'PIX', description: 'Aluguel outubro', ...extra });

describe('receitas', () => {
  it('operador registra receita; valor em centavos é preservado', async () => {
    const f = await financeFixture();
    const res = await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { amount_cents: 7050 }) });
    expect(res.status).toBe(201);
    expect(res.json.data).toMatchObject({ amount_cents: 7050, payment_method: 'PIX', status: 'ATIVO', service_id: f.serviceId });
    expect(res.json.data.user_name).toBe('Outro Usuário');
    // custo estimado é gerencial: não vai para o operador
    expect(res.json.data).not.toHaveProperty('service_cost_snapshot_cents');
  });

  it('auditoria recebe o id correto do lançamento criado', async () => {
    const f = await financeFixture();
    const res = await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f) });
    const log = await env.DB.prepare("SELECT entity_id, details FROM audit_logs WHERE action = 'REVENUE_CREATED' AND tenant_id = ?").bind(f.tenantId).first();
    expect(log.entity_id).toBe(res.json.data.id);
    expect(JSON.parse(log.details)).toMatchObject({ amount_cents: 7000, payment_method: 'PIX' });
  });

  it('guarda o custo estimado do serviço no momento da venda', async () => {
    const f = await financeFixture();
    const product = await env.DB.prepare(
      "INSERT INTO products (tenant_id, name, unit, avg_cost_micro) VALUES (?, 'Shampoo', 'ML', 17000) RETURNING id", // R$ 17,00/L
    ).bind(f.tenantId).first();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO service_costs (tenant_id, service_id, product_id, description, qty) VALUES (?, ?, ?, 'Shampoo', 100)").bind(f.tenantId, f.serviceId, product.id),
      env.DB.prepare("INSERT INTO service_costs (tenant_id, service_id, description, fixed_cost_cents) VALUES (?, ?, 'Água', 200)").bind(f.tenantId, f.serviceId),
    ]);
    const res = await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f) });
    expect(res.json.data.service_cost_snapshot_cents).toBe(370); // 100 ml × R$0,017 = R$1,70 + R$2,00
  });

  it('sem serviço exige descrição', async () => {
    const f = await financeFixture();
    const body = { date: todayIso(), amount_cents: 1000, payment_method: 'DINHEIRO' };
    expect((await call('POST', '/api/revenues', { token: f.opToken, body })).status).toBe(400);
    expect((await call('POST', '/api/revenues', { token: f.opToken, body: { ...body, description: 'Gorjeta' } })).status).toBe(201);
  });

  it('valida valores: negativos, zero, decimais, texto, gigantes', async () => {
    const f = await financeFixture();
    for (const amount of [-100, 0, 70.5, '7050', 10_000_000_001, Number.MAX_SAFE_INTEGER + 2, null]) {
      const res = await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { amount_cents: amount }) });
      expect(res.status, String(amount)).toBe(400);
    }
    expect((await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { amount_cents: 10_000_000_000 }) })).status).toBe(201);
  });

  it('valida datas: inválida, futura, muito antiga, formato errado', async () => {
    const f = await financeFixture();
    for (const date of ['2026-02-30', addDays(todayIso(), 1), '1999-12-31', '03/10/2026', '', null]) {
      const res = await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { date }) });
      expect(res.status, String(date)).toBe(400);
    }
  });

  it('valida forma de pagamento e campos extras', async () => {
    const f = await financeFixture();
    expect((await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { payment_method: 'BOLETO' }) })).status).toBe(400);
    expect((await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { status: 'CANCELADO' }) })).status).toBe(400);
    expect((await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { user_id: 1 }) })).status).toBe(400);
  });

  it('não aceita serviço de outro lava-jato nem serviço inativo', async () => {
    const f = await financeFixture();
    const other = await seedTenant();
    const foreignService = await seedService(other.tenantId);
    const inactive = await seedService(f.tenantId, { active: 0 });
    expect((await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { service_id: foreignService }) })).status).toBe(400);
    expect((await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { service_id: inactive }) })).status).toBe(400);
    expect((await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { service_id: 99999999 }) })).status).toBe(400);
  });

  it('operador não edita nem cancela; admin edita com auditoria', async () => {
    const f = await financeFixture();
    const { json } = await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f) });
    const id = json.data.id;

    expect((await call('PUT', `/api/revenues/${id}`, { token: f.opToken, body: { amount_cents: 1 } })).status).toBe(403);
    expect((await call('DELETE', `/api/revenues/${id}`, { token: f.opToken })).status).toBe(403);

    const res = await call('PUT', `/api/revenues/${id}`, { token: f.adminToken, body: { amount_cents: 8000, payment_method: 'CREDITO' } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ amount_cents: 8000, payment_method: 'CREDITO' });
    const log = await env.DB.prepare("SELECT details FROM audit_logs WHERE action = 'REVENUE_UPDATED' AND entity_id = ?").bind(id).first();
    expect(JSON.parse(log.details)).toEqual({ before: { amount_cents: 7000, payment_method: 'PIX' }, after: { amount_cents: 8000, payment_method: 'CREDITO' } });
  });

  it('cancelar mantém o registro, guarda motivo e impede nova alteração', async () => {
    const f = await financeFixture();
    const { json } = await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f) });
    const id = json.data.id;

    const res = await call('DELETE', `/api/revenues/${id}`, { token: f.adminToken, body: { reason: 'Lançado em dobro' } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ status: 'CANCELADO', cancel_reason: 'Lançado em dobro' });
    expect(res.json.data.cancelled_by_name).toBeTruthy();

    const row = await env.DB.prepare('SELECT status FROM revenues WHERE id = ?').bind(id).first();
    expect(row.status).toBe('CANCELADO');
    expect((await call('DELETE', `/api/revenues/${id}`, { token: f.adminToken })).status).toBe(409);
    expect((await call('PUT', `/api/revenues/${id}`, { token: f.adminToken, body: { amount_cents: 1 } })).status).toBe(409);
  });

  it('cancelar sem corpo também funciona', async () => {
    const f = await financeFixture();
    const { json } = await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f) });
    expect((await call('DELETE', `/api/revenues/${json.data.id}`, { token: f.adminToken })).status).toBe(200);
  });

  it('isolamento: não lê, edita nem cancela receita de outro lava-jato', async () => {
    const a = await financeFixture();
    const b = await financeFixture();
    const { json } = await call('POST', '/api/revenues', { token: b.adminToken, body: revenue(b) });
    const id = json.data.id;
    expect((await call('GET', `/api/revenues/${id}`, { token: a.adminToken })).status).toBe(404);
    expect((await call('PUT', `/api/revenues/${id}`, { token: a.adminToken, body: { amount_cents: 1 } })).status).toBe(404);
    expect((await call('DELETE', `/api/revenues/${id}`, { token: a.adminToken })).status).toBe(404);
    const list = await call('GET', '/api/revenues', { token: a.adminToken });
    expect(list.json.data.items.map((r) => r.id)).not.toContain(id);
  });

  it('lista com filtros, busca e paginação', async () => {
    const f = await financeFixture();
    await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f, { payment_method: 'DINHEIRO', description: 'Polimento 50% off' }) });
    await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f, { payment_method: 'PIX' }) });

    const pix = await call('GET', '/api/revenues?payment_method=PIX', { token: f.adminToken });
    expect(pix.json.data.items.every((r) => r.payment_method === 'PIX')).toBe(true);

    const search = await call('GET', `/api/revenues?q=${encodeURIComponent('50%')}`, { token: f.adminToken });
    expect(search.json.data.items).toHaveLength(1);
    const wildcard = await call('GET', `/api/revenues?q=${encodeURIComponent('%')}`, { token: f.adminToken });
    expect(wildcard.json.data.items).toHaveLength(1); // "%" é literal, não curinga

    expect((await call('GET', '/api/revenues?page=0', { token: f.adminToken })).status).toBe(400);
    expect((await call('GET', '/api/revenues?status=QUALQUER', { token: f.adminToken })).status).toBe(400);
    expect((await call('GET', "/api/revenues?payment_method=PIX' OR '1'='1", { token: f.adminToken })).status).toBe(400);
  });
});

describe('despesas', () => {
  it('registra despesa com o tipo padrão da categoria', async () => {
    const f = await financeFixture();
    const fixed = await call('POST', '/api/expenses', { token: f.opToken, body: expense(f) });
    expect(fixed.status).toBe(201);
    expect(fixed.json.data).toMatchObject({ type: 'DESPESA_FIXA', category_id: f.categoryId });

    const variable = await call('POST', '/api/expenses', { token: f.opToken, body: expense(f, { category_id: f.variableCategoryId }) });
    expect(variable.json.data.type).toBe('CUSTO_VARIAVEL');

    const override = await call('POST', '/api/expenses', { token: f.opToken, body: expense(f, { type: 'OUTRA' }) });
    expect(override.json.data.type).toBe('OUTRA');
  });

  it('exige categoria válida, ativa, de despesa e do próprio lava-jato', async () => {
    const f = await financeFixture();
    const other = await seedTenant();
    const cases = [
      await seedCategory(other.tenantId),
      await seedCategory(f.tenantId, { active: 0 }),
      await seedCategory(f.tenantId, { kind: 'PRODUTO' }),
      99999999,
      '1',
    ];
    for (const categoryId of cases) {
      expect((await call('POST', '/api/expenses', { token: f.opToken, body: expense(f, { category_id: categoryId }) })).status, String(categoryId)).toBe(400);
    }
    expect((await call('POST', '/api/expenses', { token: f.opToken, body: expense(f, { category_id: undefined }) })).status).toBe(400);
    expect((await call('POST', '/api/expenses', { token: f.opToken, body: expense(f, { type: 'LUCRO' }) })).status).toBe(400);
  });

  it('admin edita categoria e tipo; operador não', async () => {
    const f = await financeFixture();
    const { json } = await call('POST', '/api/expenses', { token: f.opToken, body: expense(f) });
    expect((await call('PUT', `/api/expenses/${json.data.id}`, { token: f.opToken, body: { type: 'OUTRA' } })).status).toBe(403);
    const res = await call('PUT', `/api/expenses/${json.data.id}`, { token: f.adminToken, body: { category_id: f.variableCategoryId, type: 'CUSTO_VARIAVEL' } });
    expect(res.json.data).toMatchObject({ category_id: f.variableCategoryId, type: 'CUSTO_VARIAVEL' });
  });

  it('cancelamento é auditado', async () => {
    const f = await financeFixture();
    const { json } = await call('POST', '/api/expenses', { token: f.adminToken, body: expense(f) });
    await call('DELETE', `/api/expenses/${json.data.id}`, { token: f.adminToken, body: { reason: 'Valor errado' } });
    const log = await env.DB.prepare("SELECT details FROM audit_logs WHERE action = 'EXPENSE_CANCELLED' AND entity_id = ?").bind(json.data.id).first();
    expect(JSON.parse(log.details)).toMatchObject({ amount_cents: 250000, reason: 'Valor errado' });
  });

  it('texto com HTML é salvo literalmente', async () => {
    const f = await financeFixture();
    const description = '<script>alert(1)</script>';
    const res = await call('POST', '/api/expenses', { token: f.opToken, body: expense(f, { description }) });
    expect(res.json.data.description).toBe(description);
  });
});

describe('usuário bloqueado ou sem sessão', () => {
  it('sem token não lança nada', async () => {
    expect((await call('POST', '/api/revenues', { body: { amount_cents: 100 } })).status).toBe(401);
    expect((await call('GET', '/api/cash')).status).toBe(401);
  });

  it('lava-jato bloqueado perde acesso aos lançamentos', async () => {
    const f = await financeFixture();
    await env.DB.prepare("UPDATE tenants SET status = 'BLOQUEADO' WHERE id = ?").bind(f.tenantId).run();
    expect((await call('GET', '/api/revenues', { token: f.adminToken })).status).toBe(401);
    expect((await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f) })).status).toBe(401);
  });

  it('login de operador continua funcionando para lançar', async () => {
    const t = await seedTenant({ role: 'OPERADOR' });
    const token = await login(t.email);
    const cat = await seedCategory(t.tenantId);
    const res = await call('POST', '/api/expenses', { token, body: { date: todayIso(), category_id: cat, amount_cents: 100, payment_method: 'OUTRO' } });
    expect(res.status).toBe(201);
  });
});
