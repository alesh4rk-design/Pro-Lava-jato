import { describe, it, expect } from 'vitest';
import { call, seedTenant, seedUser, login, adminSession, env, unique, firebaseToken, tokenFor, newFirebaseAccount } from './helpers.js';
import { sha256Hex } from '../src/lib/crypto.js';

const loginWith = (id_token, extra = {}) => call('POST', '/api/auth/login', { body: { id_token }, ...extra });

describe('login do lava-jato (token do Firebase)', () => {
  it('entra com token válido e devolve token, usuário e lava-jato', async () => {
    const { email, tenantId } = await seedTenant({ name: 'Brilho Car' });
    const res = await loginWith(await tokenFor(email));

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

  it('recusa tokens forjados, vencidos ou de outro projeto, todos com a mesma resposta', async () => {
    const { email } = await seedTenant();
    const row = await env.DB.prepare('SELECT firebase_uid AS uid FROM users WHERE email = ?').bind(email).first();
    const identity = { uid: row.uid, email };
    const now = Math.floor(Date.now() / 1000);
    const valid = await firebaseToken(identity);
    const [h, p, sig] = valid.split('.');
    const forgedPayload = btoa(JSON.stringify({ ...JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))), sub: 'outro' })).replace(/=+$/, '');

    const bad = [
      `${h}.${forgedPayload}.${sig}`, // conteúdo alterado, assinatura antiga
      `${h}.${p}.${sig.slice(0, -4)}AAAA`, // assinatura adulterada
      await firebaseToken(identity, { exp: now - 10 }), // vencido
      await firebaseToken(identity, { aud: 'outro-projeto' }),
      await firebaseToken(identity, { iss: 'https://securetoken.google.com/outro-projeto' }),
      await firebaseToken(identity, { iat: now + 3600 }),
      await firebaseToken(identity, { email: undefined }),
      await firebaseToken(identity, {}, { kid: 'chave-desconhecida' }),
      await firebaseToken(identity, {}, { alg: 'none' }),
      'abc.def', 'lixo', '', null, 123, { $ne: '' },
    ];
    const responses = [];
    for (const token of bad) responses.push(await loginWith(token));
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.json.error.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('conta do Firebase sem cadastro no sistema recebe a mesma resposta de token inválido', async () => {
    const stranger = await newFirebaseAccount();
    const res = await loginWith(stranger.idToken);
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('informa acesso pendente, bloqueado ou usuário desativado só com token válido', async () => {
    const pending = await seedTenant({ status: 'PENDENTE' });
    const blocked = await seedTenant({ status: 'BLOQUEADO' });
    const inactive = await seedTenant({ active: 0 });

    const codeFor = async (email) => (await loginWith(await tokenFor(email))).json.error.code;
    expect(await codeFor(pending.email)).toBe('ACCESS_PENDING');
    expect(await codeFor(blocked.email)).toBe('ACCESS_BLOCKED');
    expect(await codeFor(inactive.email)).toBe('USER_INACTIVE');
    expect((await loginWith('token.invalido.x')).json.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('bloqueia muitas tentativas vindas do mesmo IP', async () => {
    const ip = '203.0.113.7';
    let last;
    for (let i = 0; i < 31; i += 1) last = await loginWith('token.invalido.x', { ip });
    expect(last.status).toBe(429);
  });

  it('registra auditoria de falha com o e-mail e sem o token', async () => {
    const stranger = await newFirebaseAccount();
    await loginWith(stranger.idToken);
    const log = await env.DB.prepare("SELECT * FROM audit_logs WHERE action = 'LOGIN_FAILED' AND details LIKE ?").bind(`%${stranger.email}%`).first();
    expect(log).not.toBeNull();
    expect(JSON.stringify(log)).not.toContain(stranger.idToken);
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

describe('troca de senha (feita no Firebase)', () => {
  it('confirma com token de login recente do próprio usuário e encerra as outras sessões', async () => {
    const { email } = await seedTenant();
    const tokenA = await login(email);
    const tokenB = await login(email);

    const ok = await call('POST', '/api/auth/password', { token: tokenA, body: { id_token: await tokenFor(email) } });
    expect(ok.status).toBe(200);
    expect((await call('GET', '/api/auth/me', { token: tokenA })).status).toBe(200);
    expect((await call('GET', '/api/auth/me', { token: tokenB })).status).toBe(401);
    const log = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'PASSWORD_CHANGED'").first();
    expect(log.n).toBeGreaterThan(0);
  });

  it('recusa login antigo, token de outra pessoa e token inválido', async () => {
    const { email } = await seedTenant();
    const other = await seedTenant();
    const token = await login(email);
    const old = await tokenFor(email, { auth_time: Math.floor(Date.now() / 1000) - 3600 });
    for (const id_token of [old, await tokenFor(other.email), 'lixo']) {
      expect([400, 401]).toContain((await call('POST', '/api/auth/password', { token, body: { id_token } })).status);
    }
    expect((await call('GET', '/api/auth/me', { token })).status).toBe(200);
  });
});

describe('solicitação de acesso', () => {
  const request = (overrides = {}, ip) => call('POST', '/api/access-requests', {
    ip,
    body: { business_name: 'Auto Spa', owner_name: 'Fernanda', phone: '(11) 98888-7777', ...overrides },
  });

  it('cria lava-jato PENDENTE com o solicitante como ADMIN', async () => {
    const account = await newFirebaseAccount();
    const { email } = account;
    const res = await request({ id_token: account.idToken });
    expect(res.status).toBe(201);

    const row = await env.DB.prepare(
      'SELECT t.status, t.phone, u.role FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = ?',
    ).bind(email).first();
    expect(row).toEqual({ status: 'PENDENTE', phone: '11988887777', role: 'ADMIN' });

    expect(row.password_hash).toBeUndefined();
    const loginRes = await loginWith(await tokenFor(email));
    expect(loginRes.json.error.code).toBe('ACCESS_PENDING');
  });

  it('e-mail já cadastrado recebe a mesma resposta e não cria outro lava-jato', async () => {
    const { email } = await seedTenant();
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM tenants').first();
    const res = await request({ id_token: await tokenFor(email) });
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM tenants').first();
    expect(res.status).toBe(201);
    expect(after.n).toBe(before.n);
  });

  it('valida os dados e recusa campos extras', async () => {
    const t = async () => (await newFirebaseAccount()).idToken;
    expect((await request({ id_token: await t(), business_name: 'A' })).status).toBe(400);
    expect((await request({ id_token: 'lixo' })).status).toBe(401);
    expect((await request({})).status).toBe(401);
    expect((await request({ id_token: await t(), phone: '123' })).status).toBe(400);
    expect((await request({ id_token: await t(), business_name: 'x'.repeat(81) })).status).toBe(400);
    expect((await request({ id_token: await t(), status: 'ATIVO' })).status).toBe(400);
    expect((await request({ id_token: await t(), role: 'SUPER_ADMIN' })).status).toBe(400);
    expect((await request({ id_token: await t(), email: 'outro@teste.com' })).status).toBe(400); // e-mail só vem do token
  });

  it('limita solicitações por IP', async () => {
    const ip = '198.51.100.9';
    for (let i = 0; i < 3; i += 1) expect((await request({ id_token: (await newFirebaseAccount()).idToken }, ip)).status).toBe(201);
    expect((await request({ id_token: (await newFirebaseAccount()).idToken }, ip)).status).toBe(429);
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
