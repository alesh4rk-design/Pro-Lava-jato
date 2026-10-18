import { describe, it, expect } from 'vitest';
import { call, env, financeFixture, adminSession, todayIso } from './helpers.js';
import { addDays } from '../src/lib/dates.js';

const newCustomer = async (token, overrides = {}) => (await call('POST', '/api/customers', { token, body: { name: 'João da Silva', phone: '11988887777', vehicle: 'Gol', plate: 'ABC1D23', ...overrides } })).json.data;
const revenue = (f, o = {}) => ({ service_id: f.serviceId, amount_cents: 7000, payment_method: 'PIX', date: todayIso(), ...o });

describe('receita com o cliente que fez a limpeza', () => {
  it('administrador e operador ligam a receita a um cliente; o nome aparece no detalhe, no caixa e no Meu dia', async () => {
    const f = await financeFixture();
    const c = await newCustomer(f.opToken);
    const created = await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { customer_id: c.id }) });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ customer_id: c.id, customer_name: 'João da Silva' });

    const detail = await call('GET', `/api/revenues/${created.json.data.id}`, { token: f.opToken });
    expect(detail.json.data.customer_name).toBe('João da Silva');
    const cash = await call('GET', '/api/cash/entries?period=today', { token: f.adminToken });
    expect(cash.json.data.items.find((i) => i.kind === 'IN').customer_name).toBe('João da Silva');
    const myDay = await call('GET', '/api/my-day', { token: f.opToken });
    expect(myDay.json.data.items[0].customer_name).toBe('João da Silva');
    const adminCreated = await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f, { customer_id: c.id }) });
    expect(adminCreated.status).toBe(201);
  });

  it('o cliente é opcional; despesas não têm cliente', async () => {
    const f = await financeFixture();
    const plain = await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f) });
    expect(plain.json.data).toMatchObject({ customer_id: null, customer_name: null });
    const nulo = await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { customer_id: null }) });
    expect(nulo.status).toBe(201);
    const exp = await call('POST', '/api/expenses', { token: f.opToken, body: { date: todayIso(), category_id: f.categoryId, amount_cents: 100, payment_method: 'PIX', customer_id: 1 } });
    expect(exp.status).toBe(400);
  });

  it('recusa cliente inexistente, inativo, de outro lava-jato e valores inválidos', async () => {
    const f = await financeFixture();
    const other = await adminSession();
    const foreign = await newCustomer(other.token);
    const inactive = await newCustomer(f.adminToken, { name: 'Cliente Inativo' });
    await call('PUT', `/api/customers/${inactive.id}`, { token: f.adminToken, body: { active: false } });
    const bad = [foreign.id, inactive.id, 99999999, 0, -1, 'abc', 1.5, [1], { id: 1 }, true];
    for (const customer_id of bad) {
      expect((await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f, { customer_id }) })).status, JSON.stringify(customer_id)).toBe(400);
    }
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM revenues WHERE tenant_id = ?').bind(f.tenantId).first();
    expect(count.n).toBe(0);
  });

  it('administrador troca e remove o cliente de uma receita, com auditoria; sem mudança não audita', async () => {
    const f = await financeFixture();
    const a = await newCustomer(f.adminToken, { name: 'Ana Souza' });
    const b = await newCustomer(f.adminToken, { name: 'Bruno Lima' });
    const rev = (await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { customer_id: a.id }) })).json.data;
    const put = (body) => call('PUT', `/api/revenues/${rev.id}`, { token: f.adminToken, body });

    expect((await put({ customer_id: b.id })).json.data.customer_name).toBe('Bruno Lima');
    expect((await put({ customer_id: null })).json.data).toMatchObject({ customer_id: null, customer_name: null });
    expect((await call('PUT', `/api/revenues/${rev.id}`, { token: f.opToken, body: { customer_id: a.id } })).status).toBe(403);
    const audits = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'REVENUE_UPDATED' AND entity_id = ?").bind(rev.id).first();
    expect(audits.n).toBe(2);
    await put({ customer_id: null }); // igual ao que já está
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'REVENUE_UPDATED' AND entity_id = ?").bind(rev.id).first()).n).toBe(2);
    expect((await put({ customer_id: 99999999 })).status).toBe(400);
  });

  it('cliente desativado depois continua aparecendo nas receitas antigas', async () => {
    const f = await financeFixture();
    const c = await newCustomer(f.adminToken);
    const rev = (await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f, { customer_id: c.id }) })).json.data;
    await call('PUT', `/api/customers/${c.id}`, { token: f.adminToken, body: { active: false } });
    expect((await call('GET', `/api/revenues/${rev.id}`, { token: f.adminToken })).json.data.customer_name).toBe('João da Silva');
    // e editar outro campo da receita não exige o cliente ativo
    expect((await call('PUT', `/api/revenues/${rev.id}`, { token: f.adminToken, body: { amount_cents: 8000 } })).status).toBe(200);
  });

  it('a busca do caixa encontra pelo nome do cliente', async () => {
    const f = await financeFixture();
    const c = await newCustomer(f.adminToken, { name: 'Fernanda Rocha' });
    await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f, { customer_id: c.id }) });
    await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f) });
    const find = async (q) => (await call('GET', `/api/cash/entries?period=today&q=${encodeURIComponent(q)}`, { token: f.adminToken })).json.data.items;
    expect(await find('fernanda')).toHaveLength(1);
    const list = await call('GET', `/api/revenues?period=today&q=${encodeURIComponent('rocha')}`, { token: f.adminToken });
    expect(list.json.data.items).toHaveLength(1);
  });
});

describe('histórico do cliente', () => {
  it('conta lavagens e última visita; o total gasto só o administrador vê; cancelada não conta', async () => {
    const f = await financeFixture();
    const c = await newCustomer(f.adminToken);
    await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f, { customer_id: c.id, amount_cents: 7000 }) });
    await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { customer_id: c.id, amount_cents: 4000 }) });
    const gone = (await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { customer_id: c.id, amount_cents: 999 }) })).json.data;
    await call('DELETE', `/api/revenues/${gone.id}`, { token: f.adminToken, body: { reason: 'erro' } });
    await env.DB.prepare("INSERT INTO revenues (tenant_id, date, service_id, amount_cents, payment_method, user_id, customer_id) VALUES (?, ?, ?, 5000, 'PIX', ?, ?)")
      .bind(f.tenantId, addDays(todayIso(), -10), f.serviceId, f.userId, c.id).run();

    const admin = (await call('GET', '/api/customers', { token: f.adminToken })).json.data.items[0];
    expect(admin).toMatchObject({ visits: 3, last_visit: todayIso(), spent_cents: 16000 });
    const op = (await call('GET', '/api/customers', { token: f.opToken })).json.data.items[0];
    expect(op).toMatchObject({ visits: 3, last_visit: todayIso() });
    expect(op).not.toHaveProperty('spent_cents');
    expect(JSON.stringify(await call('PUT', `/api/customers/${c.id}`, { token: f.opToken, body: { notes: 'ok' } }).then((r) => r.json))).not.toContain('spent_cents');
  });

  it('cliente novo começa zerado e cada lava-jato conta o seu', async () => {
    const f = await financeFixture();
    const c = await newCustomer(f.adminToken);
    expect((await call('GET', '/api/customers', { token: f.adminToken })).json.data.items[0]).toMatchObject({ visits: 0, last_visit: null, spent_cents: 0 });
    expect(c).toMatchObject({ visits: 0, last_visit: null });
    const other = await financeFixture();
    expect((await call('GET', '/api/customers', { token: other.adminToken })).json.data.items).toEqual([]);
  });
});
