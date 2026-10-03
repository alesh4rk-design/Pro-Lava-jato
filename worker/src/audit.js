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

/** Marcador: usar o id do INSERT anterior no mesmo batch (last_insert_rowid()). */
export const LAST_INSERT_ID = Object.freeze({ lastInsert: true });

/**
 * @param {object} entry
 * @param {number|null} entry.tenantId
 * @param {{type: 'USER'|'SYSTEM_ADMIN'|'ANONYMOUS', id?: number}} entry.actor
 * @param {number|null|typeof LAST_INSERT_ID} entry.entityId
 * @param {boolean} [entry.onlyIfChanged] grava só se a instrução anterior do batch alterou alguma linha
 */
export async function auditStatement(env, { tenantId = null, actor, action, entity, entityId = null, details = {}, ip, onlyIfChanged = false }) {
  const fromLastInsert = entityId === LAST_INSERT_ID;
  const binds = [tenantId, actor.type, actor.id ?? null, action, entity];
  if (!fromLastInsert) binds.push(entityId);
  binds.push(JSON.stringify(scrub(details)), await hashIp(env, ip));
  return env.DB.prepare(
    `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, entity, entity_id, details, ip_hash)
     SELECT ?, ?, ?, ?, ?, ${fromLastInsert ? 'last_insert_rowid()' : '?'}, ?, ?
     ${onlyIfChanged ? 'WHERE changes() > 0' : ''}`,
  ).bind(...binds);
}

export async function audit(env, entry) {
  await (await auditStatement(env, entry)).run();
}

/** Ator a partir do contexto autenticado. */
export function actorOf(auth) {
  if (!auth) return { type: 'ANONYMOUS' };
  return auth.scope === 'system' ? { type: 'SYSTEM_ADMIN', id: auth.adminId } : { type: 'USER', id: auth.userId };
}
