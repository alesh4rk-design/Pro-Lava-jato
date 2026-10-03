import { SELF, env } from 'cloudflare:test';
import { hashPassword } from '../src/lib/crypto.js';

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
    'INSERT INTO users (tenant_id, name, email, password_hash, role, active) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
  ).bind(tenant.id, 'Usuário Teste', email, await passwordHash(), role, active).first();
  return { tenantId: tenant.id, userId: user.id, email };
}

export async function seedUser(tenantId, { role = 'OPERADOR', active = 1 } = {}) {
  const email = `${unique('user')}@teste.com`;
  const user = await env.DB.prepare(
    'INSERT INTO users (tenant_id, name, email, password_hash, role, active) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
  ).bind(tenantId, 'Outro Usuário', email, await passwordHash(), role, active).first();
  return { userId: user.id, email };
}

export async function seedSystemAdmin() {
  const email = `${unique('admin')}@sistema.com`;
  const admin = await env.DB.prepare('INSERT INTO system_admins (name, email, password_hash) VALUES (?, ?, ?) RETURNING id')
    .bind('Admin Sistema', email, await passwordHash()).first();
  return { adminId: admin.id, email };
}

export async function login(email, password = PASSWORD) {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
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
