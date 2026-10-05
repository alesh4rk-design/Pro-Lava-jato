import { describe, it, expect } from 'vitest';
import { call, financeFixture, env } from './helpers.js';

describe('configurações', () => {
  it('admin altera o nome e o telefone; a mudança é auditada com antes e depois', async () => {
    const f = await financeFixture();
    const res = await call('PUT', '/api/settings', { token: f.adminToken, body: { business_name: '  Brilho   Total  ', phone: '(11) 98888-7777' } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ business_name: 'Brilho Total', phone: '11988887777' });
    expect((await call('GET', '/api/auth/me', { token: f.adminToken })).json.data.tenant.name).toBe('Brilho Total');
    const log = await env.DB.prepare("SELECT details FROM audit_logs WHERE action = 'SETTINGS_CHANGED' AND tenant_id = ?").bind(f.tenantId).first();
    expect(JSON.parse(log.details).after.business_name).toBe('Brilho Total');
  });

  it('operador não vê nem altera', async () => {
    const f = await financeFixture();
    expect((await call('GET', '/api/settings', { token: f.opToken })).status).toBe(403);
    expect((await call('PUT', '/api/settings', { token: f.opToken, body: { business_name: 'Invadido' } })).status).toBe(403);
  });

  it('valida nome, telefone e campos extras; sem mudança não grava auditoria', async () => {
    const f = await financeFixture();
    const put = (body) => call('PUT', '/api/settings', { token: f.adminToken, body });
    expect((await put({ business_name: 'A' })).status).toBe(400);
    expect((await put({ business_name: 'x'.repeat(81) })).status).toBe(400);
    expect((await put({ phone: '123' })).status).toBe(400);
    expect((await put({ status: 'ATIVO' })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    const current = (await call('GET', '/api/settings', { token: f.adminToken })).json.data.business_name;
    await put({ business_name: current });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'SETTINGS_CHANGED' AND tenant_id = ?").bind(f.tenantId).first();
    expect(n.n).toBe(0);
  });

  it('altera só o próprio lava-jato', async () => {
    const a = await financeFixture();
    const b = await financeFixture();
    await call('PUT', '/api/settings', { token: a.adminToken, body: { business_name: 'Nome do A' } });
    expect((await call('GET', '/api/settings', { token: b.adminToken })).json.data.business_name).not.toBe('Nome do A');
  });
});
