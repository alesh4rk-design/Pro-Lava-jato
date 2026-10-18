import { describe, it, expect } from 'vitest';
import { call, seedTenant, seedSystemAdmin, systemLogin, login, tokenFor, adminSession, env } from './helpers.js';

async function systemSession() {
  const { email, adminId } = await seedSystemAdmin();
  return { adminId, token: await systemLogin(email) };
}

describe('login do administrador do sistema', () => {
  it('entra com credenciais válidas e é separado dos usuários de lava-jato', async () => {
    const { email } = await seedSystemAdmin();
    const res = await call('POST', '/api/system/auth/login', { body: { email, password: 'senha1234' } });
    expect(res.status).toBe(200);
    expect(res.json.data.user.role).toBe('SUPER_ADMIN');

    // A mesma credencial não serve no login de lava-jato (que só aceita token do Firebase).
    expect((await call('POST', '/api/auth/login', { body: { email, password: 'senha1234' } })).status).toBe(400);
  });

  it('token de lava-jato não acessa rotas do sistema e vice-versa', async () => {
    const tenant = await adminSession();
    const system = await systemSession();
    expect((await call('GET', '/api/system/tenants', { token: tenant.token })).status).toBe(401);
    expect((await call('GET', '/api/auth/me', { token: system.token })).status).toBe(401);
  });

  it('sem token não acessa o painel', async () => {
    expect((await call('GET', '/api/system/tenants')).status).toBe(401);
    expect((await call('POST', '/api/system/tenants/1/approve', { body: {} })).status).toBe(401);
  });
});

describe('gestão de lava-jatos', () => {
  it('lista com contadores e filtro por situação', async () => {
    const { token } = await systemSession();
    const pending = await seedTenant({ status: 'PENDENTE', name: 'Pendente SA' });
    const res = await call('GET', '/api/system/tenants?status=PENDENTE', { token });

    expect(res.status).toBe(200);
    expect(res.json.data.items.every((t) => t.status === 'PENDENTE')).toBe(true);
    const item = res.json.data.items.find((t) => t.id === pending.tenantId);
    expect(item).toMatchObject({ business_name: 'Pendente SA', email: pending.email, owner_name: 'Usuário Teste' });
    expect(res.json.data.counts.PENDENTE).toBeGreaterThanOrEqual(1);
    expect((await call('GET', '/api/system/tenants?status=QUALQUER', { token })).status).toBe(400);
  });

  it('autorizar libera o login do lava-jato', async () => {
    const { token, adminId } = await systemSession();
    const pending = await seedTenant({ status: 'PENDENTE' });

    const res = await call('POST', `/api/system/tenants/${pending.tenantId}/approve`, { token, body: {} });
    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe('ATIVO');
    const row = await env.DB.prepare('SELECT approved_by, approved_at FROM tenants WHERE id = ?').bind(pending.tenantId).first();
    expect(row.approved_by).toBe(adminId);
    expect(row.approved_at).toBeTruthy();
    await expect(login(pending.email)).resolves.toBeTruthy();
  });

  it('bloquear derruba as sessões abertas e impede novo login; desbloquear libera', async () => {
    const { token } = await systemSession();
    const tenant = await adminSession();

    expect((await call('POST', `/api/system/tenants/${tenant.tenantId}/block`, { token, body: {} })).status).toBe(200);
    expect((await call('GET', '/api/auth/me', { token: tenant.token })).status).toBe(401);
    const blockedLogin = await call('POST', '/api/auth/login', { body: { id_token: await tokenFor(tenant.email) } });
    expect(blockedLogin.json.error.code).toBe('ACCESS_BLOCKED');

    expect((await call('POST', `/api/system/tenants/${tenant.tenantId}/unblock`, { token, body: {} })).status).toBe(200);
    await expect(login(tenant.email)).resolves.toBeTruthy();
  });

  it('recusa transições inválidas, ações desconhecidas e IDs inexistentes', async () => {
    const { token } = await systemSession();
    const active = await seedTenant();
    expect((await call('POST', `/api/system/tenants/${active.tenantId}/approve`, { token, body: {} })).status).toBe(409);
    expect((await call('POST', `/api/system/tenants/${active.tenantId}/unblock`, { token, body: {} })).status).toBe(409);
    expect((await call('POST', `/api/system/tenants/${active.tenantId}/delete`, { token, body: {} })).status).toBe(404);
    expect((await call('POST', '/api/system/tenants/99999999/block', { token, body: {} })).status).toBe(404);
  });

  it('audita autorização e bloqueio', async () => {
    const { token, adminId } = await systemSession();
    const pending = await seedTenant({ status: 'PENDENTE' });
    await call('POST', `/api/system/tenants/${pending.tenantId}/approve`, { token, body: {} });
    const log = await env.DB.prepare("SELECT actor_type, actor_id, details FROM audit_logs WHERE action = 'TENANT_APPROVED' AND entity_id = ?")
      .bind(pending.tenantId).first();
    expect(log.actor_type).toBe('SYSTEM_ADMIN');
    expect(log.actor_id).toBe(adminId);
    expect(JSON.parse(log.details)).toMatchObject({ from: 'PENDENTE', to: 'ATIVO' });
  });
});
