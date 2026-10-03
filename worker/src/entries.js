// Base comum de receitas e despesas: validação dos campos compartilhados, listagem com filtros,
// consulta, edição e cancelamento. Cada módulo (revenues.js / expenses.js) informa sua configuração.
//
// Configuração (ledger):
//   table, alias, entity, label    nomes da tabela e da entidade
//   select                         SELECT ... FROM ... (com JOINs) sem WHERE; usa o alias
//   searchColumns                  colunas pesquisadas pela busca textual
//   refFilter                      { param, column } filtro por serviço/categoria
//   adminOnlyFields                campos removidos da resposta para OPERADOR

import { ok, readJson, errors } from './lib/http.js';
import * as v from './lib/validate.js';
import { entryDate, resolvePeriod } from './lib/dates.js';
import { auditStatement, actorOf, LAST_INSERT_ID } from './audit.js';

export const PAYMENT_METHODS = ['PIX', 'DINHEIRO', 'DEBITO', 'CREDITO', 'OUTRO'];
const STATUSES = ['ATIVO', 'CANCELADO'];
const PAGE_SIZE = 50;

export const timeZone = (env) => env.TIMEZONE || 'America/Sao_Paulo';

/** Campos comuns. Em edição (partial), só valida o que veio. */
export function parseCommon(body, env, { partial = false } = {}) {
  const data = {};
  const has = (key) => !partial || body[key] !== undefined;
  if (has('date')) data.date = entryDate(body.date, timeZone(env));
  if (has('amount_cents')) data.amount_cents = v.cents(body.amount_cents);
  if (has('payment_method')) data.payment_method = v.oneOf(body.payment_method, PAYMENT_METHODS, 'forma de pagamento');
  if (body.description !== undefined) data.description = v.optionalText(body.description, { field: 'descrição', max: 120 });
  else if (!partial) data.description = '';
  if (body.notes !== undefined) data.notes = v.optionalText(body.notes, { field: 'observação', max: 500, multiline: true });
  else if (!partial) data.notes = '';
  return data;
}

function present(ledger, auth, row) {
  if (!row) return row;
  if (auth.role === 'ADMIN') return row;
  const copy = { ...row };
  ledger.adminOnlyFields?.forEach((field) => delete copy[field]);
  return copy;
}

export async function findEntry(ledger, env, auth, idParam) {
  const row = await env.DB.prepare(`${ledger.select} WHERE ${ledger.alias}.tenant_id = ? AND ${ledger.alias}.id = ?`)
    .bind(auth.tenantId, v.id(idParam)).first();
  if (!row) throw errors.notFound(`${ledger.label} não encontrada.`);
  return row;
}

export async function getEntry(ledger, { env, auth, params }) {
  return ok(present(ledger, auth, await findEntry(ledger, env, auth, params.id)));
}

export async function listEntries(ledger, { env, auth, url }) {
  const params = url.searchParams;
  const a = ledger.alias;
  const period = resolvePeriod(params, timeZone(env));
  const where = [`${a}.tenant_id = ?`, `${a}.date BETWEEN ? AND ?`];
  const binds = [auth.tenantId, period.start, period.end];

  const status = params.get('status') ?? 'ATIVO';
  if (status !== 'TODOS') {
    where.push(`${a}.status = ?`);
    binds.push(v.oneOf(status, STATUSES, 'situação'));
  }
  const method = params.get('payment_method');
  if (method) {
    where.push(`${a}.payment_method = ?`);
    binds.push(v.oneOf(method, PAYMENT_METHODS, 'forma de pagamento'));
  }
  const refId = params.get(ledger.refFilter.param);
  if (refId) {
    where.push(`${a}.${ledger.refFilter.column} = ?`);
    binds.push(v.id(refId));
  }
  const pattern = v.likePattern(params.get('q'));
  if (pattern) {
    where.push(`(${ledger.searchColumns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    binds.push(...ledger.searchColumns.map(() => pattern));
  }

  const page = v.page(params);
  const { results } = await env.DB.prepare(
    `${ledger.select} WHERE ${where.join(' AND ')} ORDER BY ${a}.date DESC, ${a}.id DESC LIMIT ? OFFSET ?`,
  ).bind(...binds, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE).all();

  return ok({
    period,
    items: results.slice(0, PAGE_SIZE).map((row) => present(ledger, auth, row)),
    page,
    has_more: results.length > PAGE_SIZE,
  });
}

/**
 * Grava a edição de um lançamento ATIVO com auditoria (antes/depois) na mesma transação.
 * `changes` já vem validado pelo módulo; colunas vêm de listas fixas, nunca do cliente.
 */
export async function applyUpdate(ledger, { env, auth, ip }, current, changes) {
  if (current.status !== 'ATIVO') throw errors.invalidState('Lançamentos cancelados não podem ser alterados.');
  const columns = Object.keys(changes).filter((c) => changes[c] !== current[c]);
  if (!columns.length) return ok(present(ledger, auth, current));

  const now = new Date().toISOString();
  const [update] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE ${ledger.table} SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'ATIVO'`,
    ).bind(...columns.map((c) => changes[c]), now, current.id, auth.tenantId),
    await auditStatement(env, {
      tenantId: auth.tenantId,
      actor: actorOf(auth),
      action: `${ledger.entity.toUpperCase()}_UPDATED`,
      entity: ledger.entity,
      entityId: current.id,
      details: {
        before: Object.fromEntries(columns.map((c) => [c, current[c]])),
        after: Object.fromEntries(columns.map((c) => [c, changes[c]])),
      },
      ip,
    }),
  ]);
  if (update.meta.changes !== 1) throw errors.invalidState('Lançamentos cancelados não podem ser alterados.');
  return ok(present(ledger, auth, await findEntry(ledger, env, auth, String(current.id))));
}

/** Cancela (nunca apaga). Motivo opcional no corpo JSON: { "reason": "..." }. */
export async function cancelEntry(ledger, { request, env, auth, params, ip }) {
  const current = await findEntry(ledger, env, auth, params.id);
  if (current.status === 'CANCELADO') throw errors.invalidState('Este lançamento já foi cancelado.');

  const hasBody = Number(request.headers.get('Content-Length') ?? 0) > 0 || request.headers.has('Content-Type');
  const body = hasBody ? v.onlyFields(await readJson(request), ['reason']) : {};
  const reason = v.optionalText(body.reason, { field: 'motivo', max: 200 });

  const now = new Date().toISOString();
  const [update] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE ${ledger.table} SET status = 'CANCELADO', cancelled_by = ?, cancelled_at = ?, cancel_reason = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'ATIVO'`,
    ).bind(auth.userId, now, reason, now, current.id, auth.tenantId),
    await auditStatement(env, {
      tenantId: auth.tenantId,
      actor: actorOf(auth),
      action: `${ledger.entity.toUpperCase()}_CANCELLED`,
      entity: ledger.entity,
      entityId: current.id,
      details: { amount_cents: current.amount_cents, date: current.date, reason },
      ip,
    }),
  ]);
  if (update.meta.changes !== 1) throw errors.invalidState('Este lançamento já foi cancelado.');
  return ok(present(ledger, auth, await findEntry(ledger, env, auth, String(current.id))));
}

/** Insere o lançamento e a auditoria na mesma transação; devolve o registro completo. */
export async function insertEntry(ledger, { env, auth, ip }, columns) {
  const names = Object.keys(columns);
  const insert = env.DB.prepare(
    `INSERT INTO ${ledger.table} (tenant_id, user_id, ${names.join(', ')}) VALUES (?, ?, ${names.map(() => '?').join(', ')}) RETURNING id`,
  ).bind(auth.tenantId, auth.userId, ...names.map((n) => columns[n]));

  // O id só é conhecido depois do INSERT; a auditoria o lê via last_insert_rowid() na mesma transação.
  const audit = await auditStatement(env, {
    tenantId: auth.tenantId,
    actor: actorOf(auth),
    action: `${ledger.entity.toUpperCase()}_CREATED`,
    entity: ledger.entity,
    entityId: LAST_INSERT_ID,
    details: { date: columns.date, amount_cents: columns.amount_cents, payment_method: columns.payment_method },
    ip,
  });
  const [inserted] = await env.DB.batch([insert, audit]);
  return ok(present(ledger, auth, await findEntry(ledger, env, auth, String(inserted.results[0].id))), 201);
}
