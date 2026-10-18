import { describe, it, expect } from 'vitest';
import { call, seedTenant, seedUser, login, adminSession, env, newFirebaseAccount } from './helpers.js';

/** Corpo para criar usuário: a conta já foi criada no Firebase pelo navegador (aqui, simulada). */
const newUser = async (overrides = {}) => {
  const account = await newFirebaseAccount();
  return { account, body: { name: 'Operador Novo', id_token: account.idToken, role: 'OPERADOR', ...overrides } };
};

describe('RBAC de usuários', () => {
  it('operador não pode listar, criar nem alterar usuários', async () => {
    const { tenantId, userId } = await seedTenant();
    const op = await seedUser(tenantId);
    const token = await login(op.email);

    expect((await call('GET', '/api/users', { token })).status).toBe(403);
    expect((await call('POST', '/api/users', { token, body: (await newUser({ role: 'ADMIN' })).body })).status).toBe(403);
    expect((await call('PUT', `/api/users/${op.userId}`, { token, body: { role: 'ADMIN' } })).status).toBe(403);
    expect((await call('POST', `/api/users/${userId}/password`, { token, body: {} })).status).toBe(403);
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
    expect((await call('POST', `/api/users/${b.userId}/password`, { token: a.token, body: {} })).status).toBe(404);
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
    const { account, body } = await newUser();
    const res = await call('POST', '/api/users', { token, body });

    expect(res.status).toBe(201);
    expect(res.json.data).toMatchObject({ name: body.name, email: account.email, role: 'OPERADOR', active: true });
    expect(res.json.data).not.toHaveProperty('password_hash');
    await expect(login(account.email)).resolves.toBeTruthy();
  });

  it('nunca devolve hash de senha na listagem', async () => {
    const { token } = await adminSession();
    const res = await call('GET', '/api/users', { token });
    expect(JSON.stringify(res.json)).not.toContain('pbkdf2');
  });

  it('valida perfil, e-mail duplicado, token inválido e campos extras', async () => {
    const { token, email } = await adminSession();
    expect((await call('POST', '/api/users', { token, body: (await newUser({ role: 'SUPER_ADMIN' })).body })).status).toBe(400);
    const dup = await newFirebaseAccount(email);
    expect((await call('POST', '/api/users', { token, body: (await newUser({ id_token: dup.idToken })).body })).status).toBe(409);
    expect((await call('POST', '/api/users', { token, body: (await newUser({ id_token: 'lixo' })).body })).status).toBe(401);
    expect((await call('POST', '/api/users', { token, body: { ...(await newUser()).body, tenant_id: 999 } })).status).toBe(400);
    expect((await call('POST', '/api/users', { token, body: { ...(await newUser()).body, email: 'x@teste.com' } })).status).toBe(400);
    expect((await call('POST', '/api/users', { token, body: (await newUser({ name: 123 })).body })).status).toBe(400);
  });

  it('registra auditoria só com nome, e-mail e perfil', async () => {
    const { token, tenantId } = await adminSession();
    const { account, body } = await newUser();
    const res = await call('POST', '/api/users', { token, body });
    const log = await env.DB.prepare("SELECT details FROM audit_logs WHERE action = 'USER_CREATED' AND tenant_id = ? AND entity_id = ?")
      .bind(tenantId, res.json.data.id).first();
    expect(JSON.parse(log.details)).toEqual({ name: body.name, email: account.email, role: 'OPERADOR' });
    expect(log.details).not.toContain(account.idToken);
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

  it('ninguém é promovido a administrador nem rebaixado: o perfil não muda', async () => {
    const admin = await adminSession();
    const op = await seedUser(admin.tenantId);
    for (const body of [{ role: 'ADMIN' }, { role: 'OPERADOR' }, { name: 'Novo Nome', role: 'ADMIN' }]) {
      expect((await call('PUT', `/api/users/${op.userId}`, { token: admin.token, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call('PUT', `/api/users/${admin.userId}`, { token: admin.token, body: { role: 'OPERADOR' } })).status).toBe(400);
    const roles = await env.DB.prepare('SELECT id, role FROM users WHERE tenant_id = ? ORDER BY id').bind(admin.tenantId).all();
    expect(roles.results.map((r) => r.role)).toEqual(['ADMIN', 'OPERADOR']);
  });

  it('admin não pode desativar a si mesmo, mas pode mudar o próprio nome', async () => {
    const { token, userId } = await adminSession();
    expect((await call('PUT', `/api/users/${userId}`, { token, body: { active: false } })).status).toBe(409);
    expect((await call('PUT', `/api/users/${userId}`, { token, body: { name: 'Novo Nome' } })).status).toBe(200);
  });

  it('mantém pelo menos um administrador ativo (cadastros antigos com dois administradores)', async () => {
    const admin = await adminSession();
    const second = await seedUser(admin.tenantId, { role: 'ADMIN' });
    expect((await call('PUT', `/api/users/${second.userId}`, { token: admin.token, body: { active: false } })).status).toBe(200);
  });

  it('rejeita IDs malformados e inexistentes', async () => {
    const { token } = await adminSession();
    for (const badId of ['abc', '0', '-1', '1.5', '1e3', '01', "1'%20OR%201=1", '99999999']) {
      const res = await call('PUT', `/api/users/${badId}`, { token, body: { name: 'X Y' } });
      expect(res.status, badId).toBe(404);
    }
  });

  it('pedir redefinição de senha devolve o e-mail e audita (o envio é do Firebase)', async () => {
    const admin = await adminSession();
    const op = await seedUser(admin.tenantId);
    const res = await call('POST', `/api/users/${op.userId}/password`, { token: admin.token, body: {} });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ email: op.email });
    const log = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'PASSWORD_RESET' AND entity_id = ?").bind(op.userId).first();
    expect(log.n).toBe(1);
    expect((await call('POST', `/api/users/${admin.userId}/password`, { token: admin.token, body: {} })).status).toBe(409);
  });
});

describe('só operadores, no máximo 2 por lava-jato', () => {
  const create = async (token, overrides = {}) => call('POST', '/api/users', { token, body: (await newUser(overrides)).body });

  it('recusa cadastrar administrador, com mensagem clara', async () => {
    const { token } = await adminSession();
    const res = await create(token, { role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(res.json.error.message).toBe('Só é possível cadastrar operadores.');
    expect((await create(token, { role: 'OPERADOR' })).status).toBe(201);
    const sem = await call('POST', '/api/users', { token, body: { name: 'Sem Perfil', id_token: (await newFirebaseAccount()).idToken } });
    expect(sem.status).toBe(201);
    expect(sem.json.data.role).toBe('OPERADOR'); // sem perfil informado, é operador
  });

  it('o terceiro operador é recusado; desativar um libera a vaga', async () => {
    const admin = await adminSession();
    const first = await create(admin.token);
    const second = await create(admin.token);
    expect([first.status, second.status]).toEqual([201, 201]);

    const third = await create(admin.token);
    expect(third.status).toBe(409);
    expect(third.json.error.message).toContain('Limite de 2 operadores');
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = 'OPERADOR'").bind(admin.tenantId).first();
    expect(count.n).toBe(2);

    expect((await call('PUT', `/api/users/${first.json.data.id}`, { token: admin.token, body: { active: false } })).status).toBe(200);
    expect((await create(admin.token)).status).toBe(201);
  });

  it('reativar operador também respeita o limite', async () => {
    const admin = await adminSession();
    const first = await create(admin.token);
    await call('PUT', `/api/users/${first.json.data.id}`, { token: admin.token, body: { active: false } });
    await create(admin.token);
    await create(admin.token);
    const back = await call('PUT', `/api/users/${first.json.data.id}`, { token: admin.token, body: { active: true } });
    expect(back.status).toBe(409);
    const row = await env.DB.prepare('SELECT active FROM users WHERE id = ?').bind(first.json.data.id).first();
    expect(row.active).toBe(0);
    const logs = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'USER_UPDATED' AND entity_id = ? AND details LIKE '%\"active\":1%'").bind(first.json.data.id).first();
    expect(logs.n).toBe(0); // a tentativa recusada não deixa auditoria de reativação
  });

  it('cadastros ao mesmo tempo não passam do limite', async () => {
    const admin = await adminSession();
    const results = await Promise.all([1, 2, 3, 4].map(() => create(admin.token)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
  });

  it('a lista informa o limite e quantos operadores estão ativos; cada lava-jato conta o seu', async () => {
    const a = await adminSession();
    const b = await adminSession();
    await create(a.token);
    await create(a.token);
    expect((await call('GET', '/api/users', { token: a.token })).json.data.limits).toEqual({ operators_max: 2, operators_active: 2 });
    expect((await call('GET', '/api/users', { token: b.token })).json.data.limits).toEqual({ operators_max: 2, operators_active: 0 });
    expect((await create(b.token)).status).toBe(201); // o limite de A não atrapalha B
  });
});
