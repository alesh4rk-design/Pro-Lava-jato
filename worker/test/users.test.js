import { describe, it, expect } from 'vitest';
import { call, seedTenant, seedUser, login, adminSession, env, unique } from './helpers.js';

const newUser = (overrides = {}) => ({ name: 'Operador Novo', email: `${unique()}@teste.com`, password: 'senha1234', role: 'OPERADOR', ...overrides });

describe('RBAC de usuários', () => {
  it('operador não pode listar, criar nem alterar usuários', async () => {
    const { tenantId, userId } = await seedTenant();
    const op = await seedUser(tenantId);
    const token = await login(op.email);

    expect((await call('GET', '/api/users', { token })).status).toBe(403);
    expect((await call('POST', '/api/users', { token, body: newUser({ role: 'ADMIN' }) })).status).toBe(403);
    expect((await call('PUT', `/api/users/${op.userId}`, { token, body: { role: 'ADMIN' } })).status).toBe(403);
    expect((await call('POST', `/api/users/${userId}/password`, { token, body: { password: 'hackeada1' } })).status).toBe(403);
  });

  it('administrador do sistema não usa rotas de lava-jato', async () => {
    const res = await call('GET', '/api/users', { token: 'a'.repeat(43) });
    expect(res.status).toBe(401);
  });
});

describe('isolamento entre lava-jatos', () => {
  it('admin só enxerga e altera usuários do próprio lava-jato', async () => {
    const a = await adminSession();
    const b = await seedTenant();
    const bOperator = await seedUser(b.tenantId);

    const list = await call('GET', '/api/users', { token: a.token });
    const ids = list.json.data.items.map((u) => u.id);
    expect(ids).toContain(a.userId);
    expect(ids).not.toContain(b.userId);
    expect(ids).not.toContain(bOperator.userId);

    expect((await call('PUT', `/api/users/${bOperator.userId}`, { token: a.token, body: { active: false } })).status).toBe(404);
    expect((await call('POST', `/api/users/${b.userId}/password`, { token: a.token, body: { password: 'tomada123' } })).status).toBe(404);
    const untouched = await env.DB.prepare('SELECT active FROM users WHERE id = ?').bind(bOperator.userId).first();
    expect(untouched.active).toBe(1);
  });

  it('o banco recusa ligar registros de lava-jatos diferentes (FK composta)', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const category = await env.DB.prepare("INSERT INTO categories (tenant_id, name, kind) VALUES (?, 'Aluguel', 'DESPESA') RETURNING id").bind(b.tenantId).first();
    await expect(env.DB.prepare(
      "INSERT INTO expenses (tenant_id, date, category_id, amount_cents, payment_method, type, user_id) VALUES (?, '2026-10-03', ?, 1000, 'PIX', 'DESPESA_FIXA', ?)",
    ).bind(a.tenantId, category.id, a.userId).run()).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe('criação de usuários', () => {
  it('admin cria operador que já consegue entrar', async () => {
    const { token } = await adminSession();
    const data = newUser();
    const res = await call('POST', '/api/users', { token, body: data });

    expect(res.status).toBe(201);
    expect(res.json.data).toMatchObject({ name: data.name, email: data.email, role: 'OPERADOR', active: true });
    expect(res.json.data).not.toHaveProperty('password_hash');
    await expect(login(data.email)).resolves.toBeTruthy();
  });

  it('nunca devolve hash de senha na listagem', async () => {
    const { token } = await adminSession();
    const res = await call('GET', '/api/users', { token });
    expect(JSON.stringify(res.json)).not.toContain('pbkdf2');
  });

  it('valida perfil, e-mail duplicado, senha fraca e campos extras', async () => {
    const { token, email } = await adminSession();
    expect((await call('POST', '/api/users', { token, body: newUser({ role: 'SUPER_ADMIN' }) })).status).toBe(400);
    expect((await call('POST', '/api/users', { token, body: newUser({ email }) })).status).toBe(409);
    expect((await call('POST', '/api/users', { token, body: newUser({ password: '12345678' }) })).status).toBe(400);
    expect((await call('POST', '/api/users', { token, body: { ...newUser(), tenant_id: 999 } })).status).toBe(400);
    expect((await call('POST', '/api/users', { token, body: newUser({ name: 123 }) })).status).toBe(400);
  });

  it('registra auditoria sem a senha', async () => {
    const { token, tenantId } = await adminSession();
    const data = newUser({ password: 'SegredoX123' });
    const res = await call('POST', '/api/users', { token, body: data });
    const log = await env.DB.prepare("SELECT details FROM audit_logs WHERE action = 'USER_CREATED' AND tenant_id = ? AND entity_id = ?")
      .bind(tenantId, res.json.data.id).first();
    expect(JSON.parse(log.details)).toEqual({ name: data.name, email: data.email, role: 'OPERADOR' });
    expect(log.details).not.toContain('SegredoX123');
  });
});

describe('alteração de usuários', () => {
  it('desativar operador derruba a sessão dele na hora', async () => {
    const admin = await adminSession();
    const op = await seedUser(admin.tenantId);
    const opToken = await login(op.email);

    const res = await call('PUT', `/api/users/${op.userId}`, { token: admin.token, body: { active: false } });
    expect(res.status).toBe(200);
    expect(res.json.data.active).toBe(false);
    expect((await call('GET', '/api/auth/me', { token: opToken })).status).toBe(401);
  });

  it('mudança de perfil é auditada como alteração de permissão', async () => {
    const admin = await adminSession();
    const op = await seedUser(admin.tenantId);
    await call('PUT', `/api/users/${op.userId}`, { token: admin.token, body: { role: 'ADMIN' } });
    const log = await env.DB.prepare("SELECT details FROM audit_logs WHERE action = 'PERMISSION_CHANGED' AND entity_id = ?").bind(op.userId).first();
    expect(JSON.parse(log.details).before.role).toBe('OPERADOR');
  });

  it('admin não pode rebaixar nem desativar a si mesmo', async () => {
    const { token, userId } = await adminSession();
    expect((await call('PUT', `/api/users/${userId}`, { token, body: { role: 'OPERADOR' } })).status).toBe(409);
    expect((await call('PUT', `/api/users/${userId}`, { token, body: { active: false } })).status).toBe(409);
    expect((await call('PUT', `/api/users/${userId}`, { token, body: { name: 'Novo Nome' } })).status).toBe(200);
  });

  it('mantém pelo menos um administrador ativo', async () => {
    const admin = await adminSession();
    const second = await seedUser(admin.tenantId, { role: 'ADMIN' });
    expect((await call('PUT', `/api/users/${second.userId}`, { token: admin.token, body: { role: 'OPERADOR' } })).status).toBe(200);
  });

  it('rejeita IDs malformados e inexistentes', async () => {
    const { token } = await adminSession();
    for (const badId of ['abc', '0', '-1', '1.5', '1e3', '01', "1'%20OR%201=1", '99999999']) {
      const res = await call('PUT', `/api/users/${badId}`, { token, body: { name: 'X Y' } });
      expect(res.status, badId).toBe(404);
    }
  });

  it('redefinir senha encerra as sessões do usuário', async () => {
    const admin = await adminSession();
    const op = await seedUser(admin.tenantId);
    const opToken = await login(op.email);
    const res = await call('POST', `/api/users/${op.userId}/password`, { token: admin.token, body: { password: 'trocada123' } });
    expect(res.status).toBe(200);
    expect((await call('GET', '/api/auth/me', { token: opToken })).status).toBe(401);
    await expect(login(op.email, 'trocada123')).resolves.toBeTruthy();
  });
});
