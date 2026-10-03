// CORS, autenticação, RBAC e rate limiting.

import { errors } from './lib/http.js';
import { sha256Hex } from './lib/crypto.js';

/* CORS ---------------------------------------------------------------------- */

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
}

/** Cabeçalhos CORS para a origem da requisição, ou null se a origem não for permitida. */
export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/**
 * Requisições de navegador vindas de origem não autorizada são recusadas antes de qualquer
 * processamento. Sem cabeçalho Origin (ex.: curl), a requisição segue e depende do token.
 */
export function assertOrigin(request, env) {
  if (request.headers.has('Origin') && !corsHeaders(request, env)) throw errors.forbidden();
}

/* Sessões -------------------------------------------------------------------- */

export const SESSION_TTL_MS = { tenant: 7 * 24 * 3600_000, system: 12 * 3600_000 };
const REFRESH_AFTER_MS = 15 * 60_000;

function bearerToken(request) {
  const header = request.headers.get('Authorization') ?? '';
  const match = header.match(/^Bearer ([A-Za-z0-9_-]{20,100})$/);
  return match ? match[1] : null;
}

/** Renova a validade de sessões em uso, no máximo uma escrita a cada 15 minutos. */
async function touchSession(env, session, scope, nowMs) {
  if (nowMs - Date.parse(session.last_seen_at) < REFRESH_AFTER_MS) return;
  await env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
    .bind(new Date(nowMs).toISOString(), new Date(nowMs + SESSION_TTL_MS[scope]).toISOString(), session.id)
    .run();
}

/**
 * Autentica o usuário de lava-jato. A sessão só vale se o usuário estiver ativo
 * e o lava-jato estiver ATIVO: bloquear o lava-jato derruba o acesso na próxima requisição.
 */
export async function authenticateTenant(request, env) {
  const token = bearerToken(request);
  if (!token) throw errors.unauthenticated();
  const now = new Date();
  const row = await env.DB.prepare(
    `SELECT s.id, s.last_seen_at, u.id AS user_id, u.name, u.role, u.email, t.id AS tenant_id, t.business_name
       FROM sessions s
       JOIN users u   ON u.id = s.user_id AND u.tenant_id = s.tenant_id
       JOIN tenants t ON t.id = s.tenant_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        AND u.active = 1 AND t.status = 'ATIVO'`,
  ).bind(await sha256Hex(token), now.toISOString()).first();
  if (!row) throw errors.unauthenticated();

  await touchSession(env, row, 'tenant', now.getTime());
  return {
    scope: 'tenant',
    sessionId: row.id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    role: row.role,
    name: row.name,
    email: row.email,
    tenantName: row.business_name,
  };
}

export async function authenticateSystem(request, env) {
  const token = bearerToken(request);
  if (!token) throw errors.unauthenticated();
  const now = new Date();
  const row = await env.DB.prepare(
    `SELECT s.id, s.last_seen_at, a.id AS admin_id, a.name
       FROM sessions s JOIN system_admins a ON a.id = s.system_admin_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND a.active = 1`,
  ).bind(await sha256Hex(token), now.toISOString()).first();
  if (!row) throw errors.unauthenticated();

  await touchSession(env, row, 'system', now.getTime());
  return { scope: 'system', sessionId: row.id, adminId: row.admin_id, role: 'SUPER_ADMIN', name: row.name };
}

/* RBAC ------------------------------------------------------------------------ */

export const ROLES = Object.freeze({ ADMIN: 'ADMIN', OPERADOR: 'OPERADOR' });

export function requireRole(auth, ...roles) {
  if (!roles.includes(auth.role)) throw errors.forbidden();
}

/* Rate limiting (janela fixa, contador atômico no D1) --------------------------- */

export async function rateLimit(env, key, limit, windowSeconds) {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - windowSeconds;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT (key) DO UPDATE SET
       count        = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
     RETURNING count`,
  ).bind(key, nowSec, windowStart).first();
  if (row.count > limit) throw errors.rateLimited();
}

export async function resetRateLimit(env, key) {
  await env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') ?? '';
}
