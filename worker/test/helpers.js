import { SELF, env } from 'cloudflare:test';
import { hashPassword } from '../src/lib/crypto.js';

const b64url = (value) => btoa(typeof value === 'string' ? value : String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Token no formato do Firebase, assinado com a chave de teste. `overrides` altera/remove campos do conteúdo. */
export async function firebaseToken({ uid, email }, overrides = {}, { alg = 'RS256', kid = 'chave-teste' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: 'https://securetoken.google.com/projeto-teste', aud: 'projeto-teste', sub: uid, email, auth_time: now, iat: now, exp: now + 3600, ...overrides };
  const input = `${b64url(JSON.stringify({ alg, kid, typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.TEST_FIREBASE_PRIVATE_JWK), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  return `${input}.${b64url(signature)}`;
}

/** Simula o cadastro no Firebase de um e-mail novo: devolve uid e token. */
export async function newFirebaseAccount(email = `${unique('fb')}@teste.com`) {
  const identity = { uid: unique('uid'), email };
  return { ...identity, idToken: await firebaseToken(identity) };
}

export const ORIGIN = 'https://app.teste';
export const PASSWORD = 'senha1234';

let seq = 0;
export const unique = (prefix = 'u') => `${prefix}${Date.now().toString(36)}${(seq += 1)}`;
const randomIp = () => `10.${seq % 250}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

/** Chamada HTTP ao Worker. Cada chamada usa um IP diferente, salvo quando `ip` é informado. */
export async function call(method, path, { body, token, origin = ORIGIN, ip = randomIp(), headers = {} } = {}) {
  const init = { method, headers: { 'CF-Connecting-IP': ip, ...headers } };
  if (origin) init.headers.Origin = origin;
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.headers['Content-Type'] ??= 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await SELF.fetch(`https://api.teste${path}`, init);
  const json = response.headers.get('Content-Type')?.includes('json') ? await response.json() : null;
  return { status: response.status, json, headers: response.headers };
}

let cachedHash;
const passwordHash = async () => (cachedHash ??= await hashPassword(PASSWORD));

/** Cria um lava-jato com um usuário. Retorna ids e e-mail. */
export async function seedTenant({ status = 'ATIVO', role = 'ADMIN', active = 1, name = 'Lava Teste' } = {}) {
  const tenant = await env.DB.prepare('INSERT INTO tenants (business_name, status) VALUES (?, ?) RETURNING id').bind(name, status).first();
  const email = `${unique('user')}@teste.com`;
  const user = await env.DB.prepare(
    'INSERT INTO users (tenant_id, name, email, password_hash, firebase_uid, role, active) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
  ).bind(tenant.id, 'Usuário Teste', email, 'firebase', unique('uid'), role, active).first();
  return { tenantId: tenant.id, userId: user.id, email };
}

export async function seedUser(tenantId, { role = 'OPERADOR', active = 1 } = {}) {
  const email = `${unique('user')}@teste.com`;
  const user = await env.DB.prepare(
    'INSERT INTO users (tenant_id, name, email, password_hash, firebase_uid, role, active) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
  ).bind(tenantId, 'Outro Usuário', email, 'firebase', unique('uid'), role, active).first();
  return { userId: user.id, email };
}

export async function seedSystemAdmin() {
  const email = `${unique('admin')}@sistema.com`;
  const admin = await env.DB.prepare('INSERT INTO system_admins (name, email, password_hash) VALUES (?, ?, ?) RETURNING id')
    .bind('Admin Sistema', email, await passwordHash()).first();
  return { adminId: admin.id, email };
}

/** Token do Firebase de um usuário já cadastrado no banco (pelo e-mail). */
export async function tokenFor(email, overrides) {
  const row = await env.DB.prepare('SELECT firebase_uid FROM users WHERE email = ?').bind(email).first();
  return firebaseToken({ uid: row?.firebase_uid ?? 'uid-inexistente', email }, overrides);
}

export async function login(email) {
  const res = await call('POST', '/api/auth/login', { body: { id_token: await tokenFor(email) } });
  if (res.status !== 200) throw new Error(`login falhou: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json.data.token;
}

export async function systemLogin(email, password = PASSWORD) {
  const res = await call('POST', '/api/system/auth/login', { body: { email, password } });
  if (res.status !== 200) throw new Error(`login do sistema falhou: ${res.status}`);
  return res.json.data.token;
}

/** Lava-jato ativo com ADMIN logado. */
export async function adminSession() {
  const seeded = await seedTenant();
  return { ...seeded, token: await login(seeded.email) };
}

export { env };

export async function seedCategory(tenantId, { name = unique('Cat'), kind = 'DESPESA', type = 'DESPESA_FIXA', active = 1 } = {}) {
  const row = await env.DB.prepare(
    'INSERT INTO categories (tenant_id, name, kind, default_expense_type, active) VALUES (?, ?, ?, ?, ?) RETURNING id',
  ).bind(tenantId, name, kind, kind === 'DESPESA' ? type : null, active).first();
  return row.id;
}

export async function seedService(tenantId, { name = unique('Serv'), priceCents = 7000, active = 1 } = {}) {
  const row = await env.DB.prepare('INSERT INTO services (tenant_id, name, price_cents, active) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(tenantId, name, priceCents, active).first();
  return row.id;
}

/** "Hoje" no fuso do lava-jato, como o Worker calcula. */
export const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

/** Lava-jato com ADMIN logado, um OPERADOR logado, uma categoria e um serviço. */
export async function financeFixture() {
  const admin = await adminSession();
  const op = await seedUser(admin.tenantId);
  return {
    ...admin,
    adminToken: admin.token,
    opToken: await login(op.email),
    opUserId: op.userId,
    categoryId: await seedCategory(admin.tenantId, { type: 'DESPESA_FIXA' }),
    variableCategoryId: await seedCategory(admin.tenantId, { type: 'CUSTO_VARIAVEL' }),
    serviceId: await seedService(admin.tenantId, { priceCents: 7000 }),
  };
}
