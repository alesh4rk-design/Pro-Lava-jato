// Logs de auditoria. Os registros são montados como statements para entrar no mesmo
// db.batch() da alteração: ou a mudança e o log são gravados juntos, ou nenhum dos dois.

import { sha256Hex } from './lib/crypto.js';
import { ok } from './lib/http.js';
import * as v from './lib/validate.js';
import { resolvePeriod, localDaysToUtcRange } from './lib/dates.js';

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

/* Consulta ------------------------------------------------------------------------- */

/** Grupos de ações para os filtros da tela de auditoria. */
export const ACTION_GROUPS = {
  ACESSOS: ['LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PASSWORD_CHANGED'],
  LANCAMENTOS: ['REVENUE_CREATED', 'REVENUE_UPDATED', 'REVENUE_CANCELLED', 'EXPENSE_CREATED', 'EXPENSE_UPDATED', 'EXPENSE_CANCELLED'],
  ESTOQUE: ['PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_MOVEMENT'],
  CADASTROS: ['CATEGORY_CREATED', 'CATEGORY_UPDATED', 'SERVICE_CREATED', 'SERVICE_UPDATED', 'SERVICE_PRICE_CHANGED', 'SERVICE_COSTS_CHANGED'],
  USUARIOS: ['USER_CREATED', 'USER_UPDATED', 'PERMISSION_CHANGED', 'PASSWORD_RESET', 'ACCESS_REQUESTED'],
};

const PLATFORM_ACTIONS = ['ACCESS_REQUESTED', 'ACCESS_REQUEST_DUPLICATE', 'TENANT_APPROVED', 'TENANT_BLOCKED', 'TENANT_UNBLOCKED', 'SYSTEM_LOGIN', 'SYSTEM_LOGIN_FAILED'];
const PAGE_SIZE = 50;
const timeZone = (env) => env.TIMEZONE || 'America/Sao_Paulo';

function parseRow(row) {
  let details = {};
  try {
    details = JSON.parse(row.details);
  } catch {
    // detalhes inválidos não impedem a listagem
  }
  return { ...row, details };
}

function filters(env, url) {
  const params = url.searchParams;
  const period = resolvePeriod(params, timeZone(env));
  const range = localDaysToUtcRange(period.start, period.end, timeZone(env));
  const group = params.get('group');
  const actions = group ? ACTION_GROUPS[v.oneOf(group, Object.keys(ACTION_GROUPS), 'grupo')] : null;
  return { period, range, actions, page: v.page(params) };
}

const inList = (column, values) => (values ? ` AND ${column} IN (${values.map(() => '?').join(', ')})` : '');

/** Auditoria do lava-jato (somente ADMIN). O hash de IP nunca sai do servidor. */
export async function listTenantAudit({ env, auth, url }) {
  const f = filters(env, url);
  const userId = url.searchParams.get('user_id') ? v.id(url.searchParams.get('user_id')) : null;
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.created_at, a.actor_type, u.name AS actor_name
       FROM audit_logs a
       LEFT JOIN users u ON a.actor_type = 'USER' AND u.id = a.actor_id AND u.tenant_id = a.tenant_id
      WHERE a.tenant_id = ? AND a.created_at >= ? AND a.created_at < ?${inList('a.action', f.actions)}
        AND (? IS NULL OR (a.actor_type = 'USER' AND a.actor_id = ?))
      ORDER BY a.id DESC LIMIT ? OFFSET ?`,
  ).bind(auth.tenantId, f.range.from, f.range.to, ...(f.actions ?? []), userId, userId, PAGE_SIZE + 1, (f.page - 1) * PAGE_SIZE).all();
  return ok({ period: f.period, items: results.slice(0, PAGE_SIZE).map(parseRow), page: f.page, has_more: results.length > PAGE_SIZE });
}

/** Auditoria da plataforma (administrador do sistema): autorizações, bloqueios e acessos. */
export async function listSystemAudit({ env, url }) {
  const f = filters(env, url);
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.created_at, a.actor_type,
            sa.name AS actor_name, t.business_name
       FROM audit_logs a
       LEFT JOIN system_admins sa ON a.actor_type = 'SYSTEM_ADMIN' AND sa.id = a.actor_id
       LEFT JOIN tenants t ON t.id = a.tenant_id
      WHERE a.created_at >= ? AND a.created_at < ?
        AND (a.actor_type = 'SYSTEM_ADMIN' OR a.action IN (${PLATFORM_ACTIONS.map(() => '?').join(', ')}))
      ORDER BY a.id DESC LIMIT ? OFFSET ?`,
  ).bind(f.range.from, f.range.to, ...PLATFORM_ACTIONS, PAGE_SIZE + 1, (f.page - 1) * PAGE_SIZE).all();
  return ok({ period: f.period, items: results.slice(0, PAGE_SIZE).map(parseRow), page: f.page, has_more: results.length > PAGE_SIZE });
}
