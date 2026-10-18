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

describe('edição de cliente pelo administrador do sistema', () => {
  it('corrige nome e telefone com auditoria; valida; lava-jato não acessa a rota', async () => {
    const { token } = await systemSession();
    const tenant = await adminSession();

    const res = await call('PUT', `/api/system/tenants/${tenant.tenantId}`, { token, body: { business_name: 'Brilho Novo', phone: '(11) 97777-6666' } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ business_name: 'Brilho Novo', phone: '11977776666' });
    const log = await env.DB.prepare("SELECT details FROM audit_logs WHERE action = 'TENANT_UPDATED' AND entity_id = ?").bind(tenant.tenantId).first();
    expect(JSON.parse(log.details).before.business_name).toBe('Lava Teste');

    expect((await call('PUT', `/api/system/tenants/${tenant.tenantId}`, { token, body: { business_name: 'A' } })).status).toBe(400);
    expect((await call('PUT', `/api/system/tenants/${tenant.tenantId}`, { token, body: { status: 'ATIVO' } })).status).toBe(400);
    expect((await call('PUT', '/api/system/tenants/99999999', { token, body: { business_name: 'Outro Nome' } })).status).toBe(404);
    expect((await call('PUT', `/api/system/tenants/${tenant.tenantId}`, { token: tenant.token, body: { business_name: 'Invasor' } })).status).toBe(401);
  });
});

describe('privacidade das ações do administrador do sistema', () => {
  it('autorizar, bloquear, desbloquear e editar não aparecem na auditoria do lava-jato, só na do sistema', async () => {
    const { token } = await systemSession();
    const pending = await seedTenant({ status: 'PENDENTE' });
    await call('POST', `/api/system/tenants/${pending.tenantId}/approve`, { token, body: {} });
    await call('POST', `/api/system/tenants/${pending.tenantId}/block`, { token, body: {} });
    await call('POST', `/api/system/tenants/${pending.tenantId}/unblock`, { token, body: {} });
    await call('PUT', `/api/system/tenants/${pending.tenantId}`, { token, body: { business_name: 'Nome Corrigido' } });

    const tenantToken = await login(pending.email);
    const own = await call('GET', '/api/audit?period=today', { token: tenantToken });
    expect(own.status).toBe(200);
    const actions = own.json.data.items.map((i) => i.action);
    expect(actions).toContain('LOGIN');
    for (const hidden of ['TENANT_APPROVED', 'TENANT_BLOCKED', 'TENANT_UNBLOCKED', 'TENANT_UPDATED']) expect(actions).not.toContain(hidden);
    expect(JSON.stringify(own.json)).not.toContain('Admin Sistema');

    const platform = await call('GET', '/api/system/audit?period=today', { token });
    const platformActions = platform.json.data.items.map((i) => i.action);
    for (const shown of ['TENANT_APPROVED', 'TENANT_BLOCKED', 'TENANT_UNBLOCKED', 'TENANT_UPDATED']) expect(platformActions).toContain(shown);
  });
});
