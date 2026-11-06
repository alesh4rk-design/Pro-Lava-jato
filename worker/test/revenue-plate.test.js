import { describe, it, expect } from 'vitest';
import { call, env, financeFixture, adminSession, todayIso } from './helpers.js';

const revenue = (f, o = {}) => ({ service_id: f.serviceId, amount_cents: 7000, payment_method: 'PIX', date: todayIso(), ...o });

describe('placa no lançamento de receita', () => {
  it('administrador e operador informam a placa (normalizada); ela aparece no detalhe, no caixa e no Meu dia', async () => {
    const f = await financeFixture();
    const created = await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { plate: ' abc-1d23 ' }) });
    expect(created.status).toBe(201);
    expect(created.json.data.plate).toBe('ABC1D23');
    expect((await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f, { plate: 'xyz 9k88' }) })).json.data.plate).toBe('XYZ9K88');

    expect((await call('GET', `/api/revenues/${created.json.data.id}`, { token: f.opToken })).json.data.plate).toBe('ABC1D23');
    const cash = await call('GET', '/api/cash/entries?period=today', { token: f.adminToken });
    expect(cash.json.data.items.filter((i) => i.kind === 'IN').map((i) => i.plate).sort()).toEqual(['ABC1D23', 'XYZ9K88']);
    const myDay = await call('GET', '/api/my-day', { token: f.opToken });
    expect(myDay.json.data.items[0].plate).toBe('ABC1D23');
  });

  it('é opcional: sem placa fica vazio; despesas não têm placa', async () => {
    const f = await financeFixture();
    expect((await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f) })).json.data.plate).toBe('');
    expect((await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { plate: '' }) })).json.data.plate).toBe('');
    expect((await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { plate: null }) })).json.data.plate).toBe('');
    const exp = await call('POST', '/api/expenses', { token: f.opToken, body: { date: todayIso(), category_id: f.categoryId, amount_cents: 100, payment_method: 'PIX', plate: 'ABC1D23' } });
    expect(exp.status).toBe(400);
    const out = (await call('GET', '/api/cash/entries?period=today', { token: f.adminToken })).json.data.items;
    expect(out.every((i) => i.kind === 'IN' ? typeof i.plate === 'string' : i.plate === null)).toBe(true);
  });

  it('recusa placas inválidas', async () => {
    const f = await financeFixture();
    for (const plate of ['!!!', 'A', 'ABCD', 'ABCDEFGHIJ', 'AB@1234', "ABC'; DROP TABLE revenues;--", 12345, ['ABC1D23'], { p: 1 }, true]) {
      expect((await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { plate }) })).status, JSON.stringify(plate)).toBe(400);
    }
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM revenues WHERE tenant_id = ?').bind(f.tenantId).first();
    expect(count.n).toBe(0);
  });

  it('administrador corrige e remove a placa, com auditoria; operador não edita', async () => {
    const f = await financeFixture();
    const rev = (await call('POST', '/api/revenues', { token: f.opToken, body: revenue(f, { plate: 'ABC1D23' }) })).json.data;
    const put = (body, token = f.adminToken) => call('PUT', `/api/revenues/${rev.id}`, { token, body });
    expect((await put({ plate: 'qwe-4r56' })).json.data.plate).toBe('QWE4R56');
    expect((await put({ plate: '' })).json.data.plate).toBe('');
    expect((await put({ plate: 'bad!' })).status).toBe(400);
    expect((await put({ plate: 'ABC1D23' }, f.opToken)).status).toBe(403);
    const logs = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'REVENUE_UPDATED' AND entity_id = ?").bind(rev.id).first();
    expect(logs.n).toBe(2);
    await put({ plate: '' }); // igual ao que já está: não audita de novo
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'REVENUE_UPDATED' AND entity_id = ?").bind(rev.id).first()).n).toBe(2);
  });

  it('a busca do caixa e da lista de receitas acha pela placa; busca com SQL não quebra', async () => {
    const f = await financeFixture();
    await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f, { plate: 'ABC1D23' }) });
    await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f, { plate: 'XYZ9K88' }) });
    await call('POST', '/api/revenues', { token: f.adminToken, body: revenue(f) });
    const cash = async (q) => (await call('GET', `/api/cash/entries?period=today&q=${encodeURIComponent(q)}`, { token: f.adminToken })).json.data.items;
    expect(await cash('xyz9')).toHaveLength(1);
    expect((await cash('ABC1D23'))[0].plate).toBe('ABC1D23');
    expect(await cash("' OR 1=1 --")).toHaveLength(0);
    const list = await call('GET', `/api/revenues?period=today&q=${encodeURIComponent('k88')}`, { token: f.adminToken });
    expect(list.json.data.items.map((i) => i.plate)).toEqual(['XYZ9K88']);
  });

  it('operador de outro lava-jato não enxerga a placa', async () => {
    const a = await financeFixture();
    const b = await financeFixture();
    const rev = (await call('POST', '/api/revenues', { token: a.opToken, body: revenue(a, { plate: 'ABC1D23' }) })).json.data;
    expect((await call('GET', `/api/revenues/${rev.id}`, { token: b.opToken })).status).toBe(404);
    expect(JSON.stringify((await call('GET', '/api/my-day', { token: b.opToken })).json)).not.toContain('ABC1D23');
    expect((await adminSession()).token).toBeTruthy();
  });
});
