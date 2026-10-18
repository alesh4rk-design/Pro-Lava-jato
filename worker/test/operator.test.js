import { describe, it, expect } from 'vitest';
import { call, env, financeFixture, adminSession, seedUser, login, todayIso } from './helpers.js';
import { addDays } from '../src/lib/dates.js';

const revenue = (f, o = {}) => ({ service_id: f.serviceId, amount_cents: 7000, payment_method: 'PIX', date: todayIso(), ...o });
const expense = (f, o = {}) => ({ category_id: f.categoryId, amount_cents: 2500, payment_method: 'DINHEIRO', date: todayIso(), ...o });

describe('o operador não vê o financeiro do lava-jato', () => {
  it('painel, caixa, listas de lançamentos, relatórios, auditoria e administração são só do administrador', async () => {
    const f = await financeFixture();
    const adminOnly = [
      '/api/dashboard?period=today', '/api/cash?period=today', '/api/cash/entries?period=today', '/api/revenues?period=today', '/api/expenses?period=today',
      '/api/reports/financial?period=today', '/api/reports/break-even?period=today', '/api/reports/categories?period=today', '/api/reports/services?period=today',
      '/api/audit', '/api/users', '/api/settings', '/api/recurring-expenses', '/api/recurring-expenses/upcoming',
    ];
    for (const path of adminOnly) {
      expect((await call('GET', path, { token: f.opToken })).status, `operador ${path}`).toBe(403);
      expect((await call('GET', path, { token: f.adminToken })).status, `administrador ${path}`).toBe(200);
      expect((await call('GET', path)).status, `visitante ${path}`).toBe(401);
    }
  });

  it('o que o operador precisa para trabalhar continua liberado', async () => {
    const f = await financeFixture();
    for (const path of ['/api/services', '/api/products', '/api/categories?kind=DESPESA', '/api/customers', '/api/message-templates', '/api/my-day', '/api/auth/me']) {
      expect((await call('GET', path, { token: f.opToken })).status, path).toBe(200);
    }
    expect((await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f) })).status).toBe(201);
    expect((await call('POST', '/api/expenses', { token: f.opToken, body: expense(f) })).status).toBe(201);
  });
});

describe('Meu dia', () => {
  it('mostra só o que a própria pessoa lançou hoje, sem custos e sem cancelados', async () => {
    const f = await financeFixture();
    const other = await seedUser(f.tenantId);
    const otherToken = await login(other.email);
    await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { amount_cents: 7000 }) });
    await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { amount_cents: 4000, description: 'Lavagem extra' }) });
    await call('POST', '/api/expenses', { token: f.opToken, body: expense(f, { amount_cents: 1500 }) });
    const cancelled = (await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { amount_cents: 999 }) })).json.data;
    await call('DELETE', `/api/revenues/${cancelled.id}`, { token: f.adminToken, body: { reason: 'erro' } });
    // Outros lançamentos que o operador NÃO pode ver: do administrador, de outro operador e de outro dia.
    await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f, { amount_cents: 123456 }) });
    await call('POST', '/api/revenues', { token: otherToken, body: revenue(f, { amount_cents: 55555 }) });
    await env.DB.prepare(
      "INSERT INTO revenues (tenant_id, date, service_id, amount_cents, payment_method, user_id) VALUES (?, ?, ?, 88888, 'PIX', ?)",
    ).bind(f.tenantId, addDays(todayIso(), -1), f.serviceId, f.opUserId).run();

    const res = await call('GET', '/api/my-day', { token: f.opToken });
    expect(res.status).toBe(200);
    const { items, revenue_count: rc, expense_count: ec, date } = res.json.data;
    expect(date).toBe(todayIso());
    expect(items.map((i) => [i.kind, i.amount_cents]).sort()).toEqual([['IN', 4000], ['IN', 7000], ['OUT', 1500]]);
    expect([rc, ec]).toEqual([2, 1]);
    expect(items.find((i) => i.amount_cents === 4000).title).toBe('Lavagem extra');
    const text = JSON.stringify(res.json);
    for (const secret of ['123456', '55555', '88888', 'cost', 'balance', 'total', 'margin']) expect(text, secret).not.toContain(secret);

    // O administrador vê o seu próprio dia, não o dos outros
    const mine = await call('GET', '/api/my-day', { token: f.adminToken });
    expect(mine.json.data.items.map((i) => i.amount_cents)).toEqual([123456]);
  });

  it('cada lava-jato só vê o próprio', async () => {
    const a = await financeFixture();
    const b = await financeFixture();
    await call('POST', '/api/revenues', { token: a.opToken, body: revenue(a) });
    expect((await call('GET', '/api/my-day', { token: b.opToken })).json.data.items).toEqual([]);
  });
});

describe('detalhe de um lançamento', () => {
  it('operador abre só o próprio lançamento de hoje; os demais respondem "não encontrado"', async () => {
    const f = await financeFixture();
    const other = await seedUser(f.tenantId);
    const otherToken = await login(other.email);
    const mine = (await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f) })).json.data;
    const theirs = (await call('POST', '/api/revenues', { token: otherToken, body: revenue(f) })).json.data;
    const mineExpense = (await call('POST', '/api/expenses', { token: f.opToken, body: expense(f) })).json.data;
    const old = await env.DB.prepare(
      "INSERT INTO revenues (tenant_id, date, service_id, amount_cents, payment_method, user_id) VALUES (?, ?, ?, 7000, 'PIX', ?) RETURNING id",
    ).bind(f.tenantId, addDays(todayIso(), -1), f.serviceId, f.opUserId).first();

    const ok = await call('GET', `/api/revenues/${mine.id}`, { token: f.opToken });
    expect(ok.status).toBe(200);
    expect(ok.json.data).not.toHaveProperty('service_cost_snapshot_cents');
    expect((await call('GET', `/api/expenses/${mineExpense.id}`, { token: f.opToken })).status).toBe(200);
    expect((await call('GET', `/api/revenues/${theirs.id}`, { token: f.opToken })).status).toBe(404);
    expect((await call('GET', `/api/revenues/${old.id}`, { token: f.opToken })).status).toBe(404);

    // O administrador abre qualquer um
    for (const id of [mine.id, theirs.id, old.id]) expect((await call('GET', `/api/revenues/${id}`, { token: f.adminToken })).status).toBe(200);
  });

  it('operador de outro lava-jato não abre nada', async () => {
    const a = await financeFixture();
    const b = await financeFixture();
    const mine = (await call('POST', '/api/revenues', { token: a.opToken, body: revenue(a) })).json.data;
    expect((await call('GET', `/api/revenues/${mine.id}`, { token: b.opToken })).status).toBe(404);
    expect((await call('GET', `/api/revenues/${mine.id}`, { token: b.adminToken })).status).toBe(404);
  });
});
