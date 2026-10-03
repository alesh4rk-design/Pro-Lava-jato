// Autenticação: login/logout de lava-jato e do administrador do sistema, troca de senha
// e solicitação de acesso de novos lava-jatos.

import { ok, readJson, errors, ApiError } from './lib/http.js';
import * as v from './lib/validate.js';
import { hashPassword, verifyPassword, burnPasswordCheck, generateToken, sha256Hex } from './lib/crypto.js';
import { rateLimit, resetRateLimit, SESSION_TTL_MS } from './middleware.js';
import { audit, auditStatement, actorOf } from './audit.js';

const LOGIN_WINDOW_S = 15 * 60;

async function loginRateLimits(env, scope, ip, email) {
  await rateLimit(env, `login:${scope}:ip:${ip}`, 20, LOGIN_WINDOW_S);
  await rateLimit(env, `login:${scope}:email:${email}`, 5, LOGIN_WINDOW_S);
}

async function createSession(env, { userId = null, tenantId = null, adminId = null }, scope) {
  const token = generateToken();
  const now = Date.now();
  const statement = env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, system_admin_id, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(await sha256Hex(token), userId, tenantId, adminId, new Date(now + SESSION_TTL_MS[scope]).toISOString(), new Date(now).toISOString());
  return { token, statement };
}

/* Lava-jato ------------------------------------------------------------------- */

export async function tenantLogin({ request, env, ip }) {
  const body = v.onlyFields(await readJson(request), ['email', 'password']);
  let email;
  try {
    email = v.email(body.email);
  } catch {
    throw errors.invalidCredentials();
  }
  const password = v.passwordInput(body.password);
  await loginRateLimits(env, 'tenant', ip, email);

  const user = await env.DB.prepare(
    `SELECT u.id, u.name, u.role, u.active, u.password_hash, t.id AS tenant_id, t.business_name, t.status
       FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = ?`,
  ).bind(email).first();

  const valid = user ? await verifyPassword(password, user.password_hash) : await burnPasswordCheck(password);
  if (!valid) {
    await audit(env, { tenantId: user?.tenant_id ?? null, actor: { type: 'ANONYMOUS' }, action: 'LOGIN_FAILED', entity: 'user', entityId: user?.id ?? null, details: { email }, ip });
    throw errors.invalidCredentials();
  }

  // Situação da conta só é revelada para quem acertou a senha.
  if (user.status === 'PENDENTE') throw new ApiError(403, 'ACCESS_PENDING', 'Seu acesso ainda não foi autorizado pelo administrador do sistema.');
  if (user.status === 'BLOQUEADO') throw new ApiError(403, 'ACCESS_BLOCKED', 'Acesso bloqueado. Entre em contato com o administrador do sistema.');
  if (!user.active) throw new ApiError(403, 'USER_INACTIVE', 'Usuário desativado. Fale com o administrador do lava-jato.');

  const { token, statement } = await createSession(env, { userId: user.id, tenantId: user.tenant_id }, 'tenant');
  await env.DB.batch([
    statement,
    env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(new Date().toISOString(), user.id),
    await auditStatement(env, { tenantId: user.tenant_id, actor: { type: 'USER', id: user.id }, action: 'LOGIN', entity: 'user', entityId: user.id, ip }),
  ]);
  await resetRateLimit(env, `login:tenant:email:${email}`);

  return ok({
    token,
    user: { id: user.id, name: user.name, role: user.role },
    tenant: { id: user.tenant_id, name: user.business_name },
  });
}

export function me({ auth }) {
  return ok({
    user: { id: auth.userId, name: auth.name, role: auth.role, email: auth.email },
    tenant: { id: auth.tenantId, name: auth.tenantName },
  });
}

export async function changePassword({ request, env, auth, ip }) {
  const body = v.onlyFields(await readJson(request), ['current_password', 'new_password']);
  const newPassword = v.newPassword(body.new_password);
  if (typeof body.current_password !== 'string' || body.current_password.length > 128) throw errors.validation('Senha atual inválida.');
  await rateLimit(env, `password:user:${auth.userId}`, 5, LOGIN_WINDOW_S);

  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ? AND tenant_id = ?').bind(auth.userId, auth.tenantId).first();
  if (!row || !(await verifyPassword(body.current_password, row.password_hash))) {
    throw new ApiError(400, 'INVALID_PASSWORD', 'A senha atual está incorreta.');
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(await hashPassword(newPassword), now, auth.userId),
    // Encerra as outras sessões: se a senha vazou, quem a usou perde o acesso.
    env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL').bind(now, auth.userId, auth.sessionId),
    await auditStatement(env, { tenantId: auth.tenantId, actor: actorOf(auth), action: 'PASSWORD_CHANGED', entity: 'user', entityId: auth.userId, ip }),
  ]);
  return ok({});
}

/** Logout para os dois escopos: revoga a sessão atual. */
export async function logout({ env, auth, ip }) {
  await env.DB.batch([
    env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(new Date().toISOString(), auth.sessionId),
    await auditStatement(env, {
      tenantId: auth.tenantId ?? null,
      actor: actorOf(auth),
      action: 'LOGOUT',
      entity: auth.scope === 'system' ? 'system_admin' : 'user',
      entityId: auth.adminId ?? auth.userId,
      ip,
    }),
  ]);
  return ok({});
}

/* Solicitação de acesso ------------------------------------------------------------ */

export async function requestAccess({ request, env, ip }) {
  await rateLimit(env, `access-request:ip:${ip}`, 3, 3600);
  const body = v.onlyFields(await readJson(request), ['business_name', 'owner_name', 'email', 'phone', 'password']);
  const data = {
    businessName: v.text(body.business_name, { field: 'o nome do lava-jato', min: 2, max: 80 }),
    ownerName: v.text(body.owner_name, { field: 'seu nome', min: 2, max: 80 }),
    email: v.email(body.email),
    phone: v.phone(body.phone),
    password: v.newPassword(body.password),
  };

  // Resposta idêntica para e-mail novo ou já cadastrado: não revela quais contas existem.
  const accepted = ok({ status: 'PENDENTE' }, 201);
  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(data.email).first();
  if (exists) {
    await audit(env, { actor: { type: 'ANONYMOUS' }, action: 'ACCESS_REQUEST_DUPLICATE', entity: 'tenant', details: { email: data.email }, ip });
    return accepted;
  }

  const passwordHash = await hashPassword(data.password);
  const tenant = await env.DB.prepare('INSERT INTO tenants (business_name, phone) VALUES (?, ?) RETURNING id')
    .bind(data.businessName, data.phone).first();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'ADMIN')`)
        .bind(tenant.id, data.ownerName, data.email, passwordHash),
      await auditStatement(env, { tenantId: tenant.id, actor: { type: 'ANONYMOUS' }, action: 'ACCESS_REQUESTED', entity: 'tenant', entityId: tenant.id, details: { business_name: data.businessName, email: data.email }, ip }),
    ]);
  } catch (error) {
    // Corrida rara (mesmo e-mail enviado ao mesmo tempo): desfaz o lava-jato sem usuário.
    await env.DB.prepare('DELETE FROM tenants WHERE id = ?').bind(tenant.id).run();
    if (String(error?.message).includes('UNIQUE')) return accepted;
    throw error;
  }
  return accepted;
}

/* Administrador do sistema ------------------------------------------------------- */

export async function systemLogin({ request, env, ip }) {
  const body = v.onlyFields(await readJson(request), ['email', 'password']);
  let email;
  try {
    email = v.email(body.email);
  } catch {
    throw errors.invalidCredentials();
  }
  const password = v.passwordInput(body.password);
  await loginRateLimits(env, 'system', ip, email);

  const admin = await env.DB.prepare('SELECT id, name, active, password_hash FROM system_admins WHERE email = ?').bind(email).first();
  const valid = admin ? await verifyPassword(password, admin.password_hash) : await burnPasswordCheck(password);
  if (!valid || !admin.active) {
    await audit(env, { actor: { type: 'ANONYMOUS' }, action: 'SYSTEM_LOGIN_FAILED', entity: 'system_admin', entityId: admin?.id ?? null, details: { email }, ip });
    throw errors.invalidCredentials();
  }

  const { token, statement } = await createSession(env, { adminId: admin.id }, 'system');
  await env.DB.batch([
    statement,
    await auditStatement(env, { actor: { type: 'SYSTEM_ADMIN', id: admin.id }, action: 'SYSTEM_LOGIN', entity: 'system_admin', entityId: admin.id, ip }),
  ]);
  await resetRateLimit(env, `login:system:email:${email}`);
  return ok({ token, user: { id: admin.id, name: admin.name, role: 'SUPER_ADMIN' } });
}
