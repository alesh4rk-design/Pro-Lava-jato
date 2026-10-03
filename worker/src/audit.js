// Logs de auditoria. Os registros são montados como statements para entrar no mesmo
// db.batch() da alteração: ou a mudança e o log são gravados juntos, ou nenhum dos dois.

import { sha256Hex } from './lib/crypto.js';

const SENSITIVE_KEY = /pass|senha|token|hash|secret|authorization/i;

function scrub(value, depth = 0) {
  if (depth > 3 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .map(([key, v]) => [key, scrub(v, depth + 1)]),
  );
}

/** IP é dado pessoal: guardamos apenas um hash com sal secreto. */
async function hashIp(env, ip) {
  if (!ip) return null;
  return (await sha256Hex(`${env.IP_HASH_SALT ?? ''}:${ip}`)).slice(0, 32);
}

/**
 * @param {object} entry
 * @param {number|null} entry.tenantId
 * @param {{type: 'USER'|'SYSTEM_ADMIN'|'ANONYMOUS', id?: number}} entry.actor
 */
export async function auditStatement(env, { tenantId = null, actor, action, entity, entityId = null, details = {}, ip }) {
  return env.DB.prepare(
    `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, entity, entity_id, details, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(tenantId, actor.type, actor.id ?? null, action, entity, entityId, JSON.stringify(scrub(details)), await hashIp(env, ip));
}

export async function audit(env, entry) {
  await (await auditStatement(env, entry)).run();
}

/** Ator a partir do contexto autenticado. */
export function actorOf(auth) {
  if (!auth) return { type: 'ANONYMOUS' };
  return auth.scope === 'system' ? { type: 'SYSTEM_ADMIN', id: auth.adminId } : { type: 'USER', id: auth.userId };
}
