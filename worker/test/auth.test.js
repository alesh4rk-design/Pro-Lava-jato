import { describe, it, expect } from 'vitest';
import { call, seedTenant, seedUser, login, adminSession, env, PASSWORD, unique } from './helpers.js';
import { sha256Hex } from '../src/lib/crypto.js';

describe('login do lava-jato', () => {
  it('entra com credenciais válidas e devolve token, usuário e lava-jato', async () => {
    const { email, tenantId } = await seedTenant({ name: 'Brilho Car' });
    const res = await call('POST', '/api/auth/login', { body: { email: email.toUpperCase(), password: PASSWORD } });

    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.data.user.role).toBe('ADMIN');
    expect(res.json.data.tenant).toEqual({ id: tenantId, name: 'Brilho Car' });
    expect(res.json.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('guarda apenas o hash do token no banco', async () => {
    const { email } = await seedTenant();
    const token = await login(email);
    const raw = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').bind(token).first();
    const hashed = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).first();
    expect(raw.n).toBe(0);
    expect(hashed.n).toBe(1);
  });

  it('senha errada e e-mail inexistente recebem a mesma resposta', async () => {
    const { email } = await seedTenant();
    const wrong = await call('POST', '/api/auth/login', { body: { email, password: 'errada123' } });
    const missing = await call('POST', '/api/auth/login', { body: { email: 'ninguem@teste.com', password: 'errada123' } });

    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.json).toEqual(missing.json);
    expect(wrong.json.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('informa acesso pendente, bloqueado ou usuário desativado só com a senha correta', async () => {
    const pending = await seedTenant({ status: 'PENDENTE' });
    const blocked = await seedTenant({ status: 'BLOQUEADO' });
    const inactive = await seedTenant({ active: 0 });

    const codeFor = async (email, password = PASSWORD) => (await call('POST', '/api/auth/login', { body: { email, password } })).json.error.code;
    expect(await codeFor(pending.email)).toBe('ACCESS_PENDING');
    expect(await codeFor(blocked.email)).toBe('ACCESS_BLOCKED');
    expect(await codeFor(inactive.email)).toBe('USER_INACTIVE');
    expect(await codeFor(pending.email, 'errada123')).toBe('INVALID_CREDENTIALS');
  });

  it('bloqueia após 5 tentativas erradas para o mesmo e-mail, mesmo trocando de IP', async () => {
    const { email } = await seedTenant();
    for (let i = 0; i < 5; i += 1) {
      expect((await call('POST', '/api/auth/login', { body: { email, password: 'errada123' } })).status).toBe(401);
    }
    const blocked = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe('RATE_LIMITED');
  });

  it('bloqueia muitas tentativas vindas do mesmo IP', async () => {
    const ip = '203.0.113.7';
    let last;
    for (let i = 0; i < 21; i += 1) {
      last = await call('POST', '/api/auth/login', { ip, body: { email: `${unique()}@teste.com`, password: 'errada123' } });
    }
    expect(last.status).toBe(429);
  });

  it('registra auditoria de falha sem guardar a senha', async () => {
    const { email, userId } = await seedTenant();
    await call('POST', '/api/auth/login', { body: { email, password: 'SenhaSecreta99' } });
    const log = await env.DB.prepare("SELECT * FROM audit_logs WHERE action = 'LOGIN_FAILED' AND entity_id = ?").bind(userId).first();
    expect(log).not.toBeNull();
    expect(JSON.stringify(log)).not.toContain('SenhaSecreta99');
    expect(log.ip_hash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('sessão', () => {
  it('rejeita requisições sem token, com token inválido ou malformado', async () => {
    expect((await call('GET', '/api/auth/me')).status).toBe(401);
    expect((await call('GET', '/api/auth/me', { token: 'x'.repeat(43) })).status).toBe(401);
    expect((await call('GET', '/api/auth/me', { headers: { Authorization: "Bearer ' OR 1=1 --" } })).status).toBe(401);
  });

  it('/me devolve o usuário da sessão', async () => {
    const { token, userId } = await adminSession();
    const res = await call('GET', '/api/auth/me', { token });
    expect(res.status).toBe(200);
    expect(res.json.data.user.id).toBe(userId);
  });

  it('logout revoga a sessão', async () => {
    const { token } = await adminSession();
    expect((await call('POST', '/api/auth/logout', { token, body: {} })).status).toBe(200);
    expect((await call('GET', '/api/auth/me', { token })).status).toBe(401);
  });

  it('sessão expirada não é aceita', async () => {
    const { token } = await adminSession();
    await env.DB.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ?").bind(await sha256Hex(token)).run();
    expect((await call('GET', '/api/auth/me', { token })).status).toBe(401);
  });

  it('usuário desativado perde o acesso imediatamente', async () => {
    const { token, userId } = await adminSession();
    await env.DB.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(userId).run();
    expect((await call('GET', '/api/auth/me', { token })).status).toBe(401);
  });
});

describe('troca de senha', () => {
  it('exige a senha atual, valida a nova e encerra as outras sessões', async () => {
    const { email } = await seedTenant();
    const tokenA = await login(email);
    const tokenB = await login(email);

    const wrong = await call('POST', '/api/auth/password', { token: tokenA, body: { current_password: 'errada123', new_password: 'novaSenha1' } });
    expect(wrong.json.error.code).toBe('INVALID_PASSWORD');

    const weak = await call('POST', '/api/auth/password', { token: tokenA, body: { current_password: PASSWORD, new_password: 'curta' } });
    expect(weak.status).toBe(400);

    const ok = await call('POST', '/api/auth/password', { token: tokenA, body: { current_password: PASSWORD, new_password: 'novaSenha1' } });
    expect(ok.status).toBe(200);
    expect((await call('GET', '/api/auth/me', { token: tokenA })).status).toBe(200);
    expect((await call('GET', '/api/auth/me', { token: tokenB })).status).toBe(401);
    await expect(login(email, 'novaSenha1')).resolves.toBeTruthy();
  });
});

describe('solicitação de acesso', () => {
  const request = (overrides = {}, ip) => call('POST', '/api/access-requests', {
    ip,
    body: { business_name: 'Auto Spa', owner_name: 'Fernanda', email: `${unique()}@teste.com`, phone: '(11) 98888-7777', password: 'senha1234', ...overrides },
  });

  it('cria lava-jato PENDENTE com o solicitante como ADMIN', async () => {
    const email = `${unique()}@teste.com`;
    const res = await request({ email });
    expect(res.status).toBe(201);

    const row = await env.DB.prepare(
      'SELECT t.status, t.phone, u.role FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = ?',
    ).bind(email).first();
    expect(row).toEqual({ status: 'PENDENTE', phone: '11988887777', role: 'ADMIN' });

    const loginRes = await call('POST', '/api/auth/login', { body: { email, password: 'senha1234' } });
    expect(loginRes.json.error.code).toBe('ACCESS_PENDING');
  });

  it('e-mail já cadastrado recebe a mesma resposta e não cria outro lava-jato', async () => {
    const { email } = await seedTenant();
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM tenants').first();
    const res = await request({ email });
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM tenants').first();
    expect(res.status).toBe(201);
    expect(after.n).toBe(before.n);
  });

  it('valida os dados e recusa campos extras', async () => {
    expect((await request({ business_name: 'A' })).status).toBe(400);
    expect((await request({ email: 'invalido' })).status).toBe(400);
    expect((await request({ password: 'semnumero' })).status).toBe(400);
    expect((await request({ phone: '123' })).status).toBe(400);
    expect((await request({ business_name: 'x'.repeat(81) })).status).toBe(400);
    expect((await request({ status: 'ATIVO' })).status).toBe(400);
    expect((await request({ role: 'SUPER_ADMIN' })).status).toBe(400);
  });

  it('limita solicitações por IP', async () => {
    const ip = '198.51.100.9';
    for (let i = 0; i < 3; i += 1) expect((await request({}, ip)).status).toBe(201);
    expect((await request({}, ip)).status).toBe(429);
  });
});

describe('perfil operador', () => {
  it('operador entra e acessa rotas comuns', async () => {
    const { tenantId } = await seedTenant();
    const op = await seedUser(tenantId);
    const token = await login(op.email);
    const me = await call('GET', '/api/auth/me', { token });
    expect(me.json.data.user.role).toBe('OPERADOR');
  });
});
