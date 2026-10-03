import { describe, it, expect } from 'vitest';
import { call, financeFixture, env, todayIso, unique } from './helpers.js';
import { addDays } from '../src/lib/dates.js';

async function post(f, path, body) {
  const res = await call('POST', path, { token: f.adminToken, body: { date: todayIso(), ...body } });
  if (res.status !== 201) throw new Error(JSON.stringify(res.json));
  return res.json.data;
}

describe('caixa', () => {
  it('entradas, saídas e saldo por forma de pagamento, ignorando cancelados', async () => {
    const f = await financeFixture();
    await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 7000, payment_method: 'PIX' });
    await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 4000, payment_method: 'DINHEIRO' });
    const cancelled = await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 99900, payment_method: 'PIX' });
    await call('DELETE', `/api/revenues/${cancelled.id}`, { token: f.adminToken });
    await post(f, '/api/expenses', { category_id: f.categoryId, amount_cents: 2500, payment_method: 'PIX' });

    const res = await call('GET', '/api/cash?period=today', { token: f.opToken });
    expect(res.status).toBe(200);
    expect(res.json.data.totals).toEqual({ in_cents: 11000, out_cents: 2500, balance_cents: 8500 });
    const pix = res.json.data.by_method.find((m) => m.method === 'PIX');
    expect(pix).toMatchObject({ in_cents: 7000, out_cents: 2500 });
    expect(res.json.data.by_method.map((m) => m.method)).toEqual(['PIX', 'DINHEIRO', 'DEBITO', 'CREDITO', 'OUTRO']);
  });

  it('saldo negativo quando as saídas superam as entradas', async () => {
    const f = await financeFixture();
    await post(f, '/api/expenses', { category_id: f.categoryId, amount_cents: 900000, payment_method: 'PIX' });
    const res = await call('GET', '/api/cash?period=today', { token: f.adminToken });
    expect(res.json.data.totals.balance_cents).toBe(-900000);
  });

  it('lista unificada com filtros de tipo, forma, busca e cancelados', async () => {
    const f = await financeFixture();
    const tag = unique('Tag');
    await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 7000, payment_method: 'PIX', description: tag });
    const out = await post(f, '/api/expenses', { category_id: f.categoryId, amount_cents: 2500, payment_method: 'DINHEIRO' });
    await call('DELETE', `/api/expenses/${out.id}`, { token: f.adminToken });

    const all = await call('GET', '/api/cash/entries?period=today', { token: f.opToken });
    expect(all.json.data.items.map((i) => i.kind)).toEqual(['IN']);

    const withCancelled = await call('GET', '/api/cash/entries?period=today&include_cancelled=1', { token: f.opToken });
    expect(withCancelled.json.data.items).toHaveLength(2);

    const onlyOut = await call('GET', '/api/cash/entries?period=today&kind=OUT&include_cancelled=1', { token: f.opToken });
    expect(onlyOut.json.data.items.map((i) => i.kind)).toEqual(['OUT']);

    const search = await call('GET', `/api/cash/entries?period=today&q=${tag}`, { token: f.opToken });
    expect(search.json.data.items).toHaveLength(1);
    expect(search.json.data.items[0].ref_name).toBeTruthy();

    expect((await call('GET', '/api/cash/entries?kind=TUDO', { token: f.opToken })).status).toBe(400);
  });

  it('respeita o período', async () => {
    const f = await financeFixture();
    const yesterday = addDays(todayIso(), -1);
    await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 1000, payment_method: 'PIX', date: yesterday });
    const today = await call('GET', '/api/cash?period=today', { token: f.adminToken });
    expect(today.json.data.totals.in_cents).toBe(0);
    const custom = await call('GET', `/api/cash?period=custom&start=${yesterday}&end=${yesterday}`, { token: f.adminToken });
    expect(custom.json.data.totals.in_cents).toBe(1000);
  });
});

describe('dashboard', () => {
  it('calcula faturamento, custos, despesas, resultado, margem e ticket', async () => {
    const f = await financeFixture();
    await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 7000, payment_method: 'PIX' });
    await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 3000, payment_method: 'PIX' });
    await post(f, '/api/expenses', { category_id: f.variableCategoryId, amount_cents: 1000, payment_method: 'PIX' });
    await post(f, '/api/expenses', { category_id: f.categoryId, amount_cents: 4000, payment_method: 'PIX' });
    await post(f, '/api/expenses', { category_id: f.categoryId, type: 'OUTRA', amount_cents: 500, payment_method: 'PIX' });

    const res = await call('GET', '/api/dashboard?period=today', { token: f.opToken });
    expect(res.status).toBe(200);
    expect(res.json.data.totals).toEqual({
      revenue_cents: 10000,
      variable_costs_cents: 1000,
      expenses_cents: 4500,
      result_cents: 4500,
      margin_bp: 4500,
      services_count: 2,
      avg_ticket_cents: 5000,
    });
    expect(res.json.data.snapshot).toMatchObject({
      revenue_today_cents: 10000,
      revenue_month_cents: 10000,
      costs_month_cents: 1000,
      expenses_month_cents: 4500,
      result_month_cents: 4500,
    });
  });

  it('receita sem serviço entra no faturamento e no ticket, mas não conta como serviço', async () => {
    const f = await financeFixture();
    await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 7000, payment_method: 'PIX' });
    await post(f, '/api/revenues', { description: 'Gorjeta', amount_cents: 1000, payment_method: 'DINHEIRO' });
    const res = await call('GET', '/api/dashboard?period=today', { token: f.adminToken });
    expect(res.json.data.totals).toMatchObject({ revenue_cents: 8000, services_count: 1, avg_ticket_cents: 4000 });
  });

  it('período sem lançamentos retorna zeros e margem nula', async () => {
    const f = await financeFixture();
    const res = await call('GET', '/api/dashboard?period=custom&start=2020-01-01&end=2020-01-31', { token: f.adminToken });
    expect(res.json.data.totals).toMatchObject({ revenue_cents: 0, result_cents: 0, margin_bp: null, avg_ticket_cents: 0 });
  });

  it('não mistura dados de outro lava-jato', async () => {
    const a = await financeFixture();
    const b = await financeFixture();
    await post(b, '/api/revenues', { service_id: b.serviceId, amount_cents: 123456, payment_method: 'PIX' });
    const res = await call('GET', '/api/dashboard?period=today', { token: a.adminToken });
    expect(res.json.data.totals.revenue_cents).toBe(0);
  });

  it('período inválido → 400', async () => {
    const f = await financeFixture();
    expect((await call('GET', '/api/dashboard?period=custom&start=2026-05-10&end=2026-05-01', { token: f.adminToken })).status).toBe(400);
  });
});

describe('categorias', () => {
  it('novo lava-jato recebe categorias padrão', async () => {
    const email = `${unique()}@teste.com`;
    await call('POST', '/api/access-requests', { body: { business_name: 'Novo LJ', owner_name: 'Dona', email, password: 'senha1234' } });
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM categories c JOIN users u ON u.tenant_id = c.tenant_id WHERE u.email = ? AND c.kind = 'DESPESA'",
    ).bind(email).first();
    expect(row.n).toBeGreaterThanOrEqual(8);
  });

  it('operador lista só ativas; admin cria, renomeia e desativa', async () => {
    const f = await financeFixture();
    expect((await call('POST', '/api/categories', { token: f.opToken, body: { name: 'X', kind: 'DESPESA' } })).status).toBe(403);

    const created = await call('POST', '/api/categories', { token: f.adminToken, body: { name: 'Seguro', kind: 'DESPESA', default_expense_type: 'DESPESA_FIXA' } });
    expect(created.status).toBe(201);
    expect((await call('POST', '/api/categories', { token: f.adminToken, body: { name: 'Seguro', kind: 'DESPESA' } })).status).toBe(409);

    const id = created.json.data.id;
    await call('PUT', `/api/categories/${id}`, { token: f.adminToken, body: { active: false } });
    const opList = await call('GET', '/api/categories?kind=DESPESA&include_inactive=1', { token: f.opToken });
    expect(opList.json.data.items.map((c) => c.id)).not.toContain(id);
    const adminList = await call('GET', '/api/categories?kind=DESPESA&include_inactive=1', { token: f.adminToken });
    expect(adminList.json.data.items.find((c) => c.id === id).active).toBe(false);

    // categoria desativada não aceita novos lançamentos
    const res = await call('POST', '/api/expenses', { token: f.opToken, body: { date: todayIso(), category_id: id, amount_cents: 100, payment_method: 'PIX' } });
    expect(res.status).toBe(400);
  });

  it('não altera categoria de outro lava-jato', async () => {
    const a = await financeFixture();
    const b = await financeFixture();
    expect((await call('PUT', `/api/categories/${b.categoryId}`, { token: a.adminToken, body: { name: 'Hack' } })).status).toBe(404);
  });
});
