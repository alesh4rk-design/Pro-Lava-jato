// Despesas recorrentes (somente ADMIN). O Worker lança a despesa a cada vencimento: Cron diário (todos os
// lava-jatos ativos) e ao abrir o app/listar (o próprio lava-jato). Lançar é idempotente: a mesma data nunca
// é lançada duas vezes, mesmo com duas execuções ao mesmo tempo.

import { ok, readJson, errors } from './lib/http.js';
import * as v from './lib/validate.js';
import { today, addDays, isValidDate } from './lib/dates.js';
import { auditStatement, actorOf } from './audit.js';
import { requireActiveCategory, EXPENSE_TYPES } from './categories.js';
import { PAYMENT_METHODS, timeZone } from './entries.js';

export const FREQUENCIES = ['DIARIA', 'SEMANAL', 'MENSAL'];
const MAX_CATCH_UP_DAYS = 62; // se o Cron ficar parado, recupera no máximo dois meses
const MAX_ACTIVE_PER_TENANT = 100;
const MAX_HORIZON_DAYS = 366;

const SELECT = `SELECT r.id, r.category_id, c.name AS category_name, r.description, r.amount_cents, r.payment_method, r.type,
                       r.frequency, r.weekday, r.month_day, r.start_date, r.end_date, r.last_generated_date, r.active,
                       r.created_at, r.updated_at
                  FROM recurring_expenses r
                  JOIN categories c ON c.tenant_id = r.tenant_id AND c.id = r.category_id`;

/* Agenda ---------------------------------------------------------------------------- */

const daysInMonth = (iso) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0)).getUTCDate();

/** A recorrência vence nesta data? (mensal: dia 31 vale como último dia do mês) */
export function isDueOn(rec, date) {
  if (date < rec.start_date || (rec.end_date && date > rec.end_date)) return false;
  if (rec.frequency === 'DIARIA') return true;
  if (rec.frequency === 'SEMANAL') return new Date(`${date}T00:00:00Z`).getUTCDay() === rec.weekday;
  return Number(date.slice(8)) === Math.min(rec.month_day, daysInMonth(date));
}

/** Datas a lançar: depois do último lançamento, até hoje (inclusive). */
export function dueDates(rec, todayIso) {
  const last = rec.last_generated_date;
  let from = last ? addDays(last, 1) : rec.start_date;
  const floor = addDays(todayIso, -MAX_CATCH_UP_DAYS);
  if (from < floor) from = floor;
  const to = rec.end_date && rec.end_date < todayIso ? rec.end_date : todayIso;
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isDueOn(rec, d)) dates.push(d);
  return dates;
}

/** Próxima data de lançamento depois do que já foi lançado (ou null se encerrada/pausada). */
export function nextDate(rec, todayIso) {
  if (!rec.active) return null;
  const afterLast = rec.last_generated_date ? addDays(rec.last_generated_date, 1) : rec.start_date;
  let d = afterLast > todayIso ? afterLast : todayIso;
  for (let i = 0; i < 400; i += 1, d = addDays(d, 1)) {
    if (rec.end_date && d > rec.end_date) return null;
    if (isDueOn(rec, d)) return d;
  }
  return null;
}

/* Lançamento automático ------------------------------------------------------------- */

/** Lança as despesas vencidas de uma recorrência. Devolve quantas foram criadas. */
async function generateOne(env, rec, todayIso) {
  const dates = dueDates(rec, todayIso);
  const upTo = rec.end_date && rec.end_date < todayIso ? rec.end_date : todayIso;
  if (!dates.length && rec.last_generated_date === upTo) return 0;

  const statements = dates.map((date) => env.DB.prepare(
    `INSERT INTO expenses (tenant_id, user_id, date, category_id, description, amount_cents, payment_method, type, notes, recurring_expense_id)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'Lançamento automático', ?9
      WHERE NOT EXISTS (SELECT 1 FROM expenses WHERE recurring_expense_id = ?9 AND date = ?3)`,
  ).bind(rec.tenant_id, rec.created_by, date, rec.category_id, rec.description, rec.amount_cents, rec.payment_method, rec.type, rec.id));

  statements.push(env.DB.prepare('UPDATE recurring_expenses SET last_generated_date = ?, updated_at = ? WHERE id = ? AND (last_generated_date IS NULL OR last_generated_date < ?1)')
    .bind(upTo, new Date().toISOString(), rec.id));
  if (dates.length) {
    statements.push(await auditStatement(env, {
      tenantId: rec.tenant_id, actor: { type: 'USER', id: rec.created_by }, action: 'EXPENSE_AUTO_CREATED', entity: 'recurring_expense', entityId: rec.id,
      details: { description: rec.description, amount_cents: rec.amount_cents, frequency: rec.frequency, dates },
    }));
  }
  await env.DB.batch(statements);
  return dates.length;
}

const DUE_FILTER = `r.active = 1 AND r.start_date <= ?1 AND (r.end_date IS NULL OR r.end_date >= COALESCE(r.last_generated_date, r.start_date))
                    AND (r.last_generated_date IS NULL OR r.last_generated_date < MIN(?1, COALESCE(r.end_date, ?1)))`;

/** Lança o que venceu. Sem tenantId, percorre todos os lava-jatos ativos (Cron diário). */
export async function generateDue(env, { tenantId = null, now = new Date() } = {}) {
  const todayIso = today(timeZone(env), now);
  const { results } = await env.DB.prepare(
    `SELECT r.* FROM recurring_expenses r JOIN tenants t ON t.id = r.tenant_id
      WHERE t.status = 'ATIVO' AND (?2 IS NULL OR r.tenant_id = ?2) AND ${DUE_FILTER}
      ORDER BY r.id LIMIT 500`,
  ).bind(todayIso, tenantId).all();
  let created = 0;
  for (const rec of results) {
    try {
      created += await generateOne(env, rec, todayIso);
    } catch (error) {
      console.error(`recorrência ${rec.id}: ${error?.message}`); // uma falha não trava as demais
    }
  }
  return created;
}

/* Rotas (ADMIN) --------------------------------------------------------------------- */

const present = (row, todayIso) => ({ ...row, active: row.active === 1, next_date: nextDate({ ...row, active: row.active === 1 }, todayIso) });

async function findOne(env, auth, idParam) {
  const row = await env.DB.prepare(`${SELECT} WHERE r.tenant_id = ? AND r.id = ?`).bind(auth.tenantId, v.id(idParam)).first();
  if (!row) throw errors.notFound('Despesa recorrente não encontrada.');
  return row;
}

export async function listRecurring({ env, auth }) {
  await generateDue(env, { tenantId: auth.tenantId });
  const todayIso = today(timeZone(env));
  const { results } = await env.DB.prepare(`${SELECT} WHERE r.tenant_id = ? ORDER BY r.active DESC, r.id DESC LIMIT 200`).bind(auth.tenantId).all();
  return ok({ items: results.map((row) => present(row, todayIso)) });
}

/** Próximos vencimentos (padrão: 7 dias): alimenta o aviso do Início. Uma linha por recorrência ativa; as diárias ficam de fora (vencem todo dia). */
export async function upcomingRecurring({ env, auth, url }) {
  await generateDue(env, { tenantId: auth.tenantId });
  const daysParam = url.searchParams.get('days') ?? '7';
  const days = /^\d{1,2}$/.test(daysParam) ? Math.min(Math.max(Number(daysParam), 1), 31) : 7;
  const todayIso = today(timeZone(env));
  const limit = addDays(todayIso, days);
  const { results } = await env.DB.prepare(`${SELECT} WHERE r.tenant_id = ? AND r.active = 1 ORDER BY r.id`).bind(auth.tenantId).all();
  const items = results
    .map((row) => ({ ...row, active: true, next_date: nextDate({ ...row, active: true }, todayIso) }))
    .filter((row) => row.frequency !== 'DIARIA' && row.next_date && row.next_date <= limit)
    .sort((a, b) => a.next_date.localeCompare(b.next_date) || b.amount_cents - a.amount_cents)
    .map((row) => ({
      id: row.id, description: row.description, category_name: row.category_name, amount_cents: row.amount_cents,
      frequency: row.frequency, next_date: row.next_date, days_left: Math.round((Date.parse(row.next_date) - Date.parse(todayIso)) / 86_400_000),
    }));
  return ok({ today: todayIso, days, items, total_cents: items.reduce((sum, row) => sum + row.amount_cents, 0) });
}

function schedule(body, current = null) {
  const frequency = body.frequency === undefined && current ? current.frequency : v.oneOf(body.frequency, FREQUENCIES, 'frequência');
  const out = { frequency, weekday: null, month_day: null };
  if (frequency === 'SEMANAL') {
    const weekday = body.weekday === undefined && current ? current.weekday : body.weekday;
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw errors.validation('Escolha o dia da semana.');
    out.weekday = weekday;
  }
  if (frequency === 'MENSAL') {
    const day = body.month_day === undefined && current ? current.month_day : body.month_day;
    if (!Number.isInteger(day) || day < 1 || day > 31) throw errors.validation('Escolha o dia do mês (1 a 31).');
    out.month_day = day;
  }
  return out;
}

function endDate(value, start, tz) {
  if (value === null || value === '') return null;
  if (!isValidDate(value) || value < start) throw errors.validation('A data final não pode ser anterior ao início.');
  if (value > addDays(today(tz), MAX_HORIZON_DAYS * 10)) throw errors.validation('Data final muito distante.');
  return value;
}

export async function createRecurring({ request, env, auth, ip }) {
  const body = v.onlyFields(await readJson(request), ['category_id', 'description', 'amount_cents', 'payment_method', 'type', 'frequency', 'weekday', 'month_day', 'start_date', 'end_date']);
  const tz = timeZone(env);
  const todayIso = today(tz);
  const category = await requireActiveCategory(env, auth.tenantId, v.bodyId(body.category_id, 'categoria'), 'DESPESA');
  const start = body.start_date === undefined ? todayIso : body.start_date;
  if (!isValidDate(start) || start < todayIso || start > addDays(todayIso, MAX_HORIZON_DAYS)) throw errors.validation('O início deve ser hoje ou uma data futura.');
  const data = {
    category_id: category.id,
    description: v.optionalText(body.description, { field: 'descrição', max: 120 }),
    amount_cents: v.cents(body.amount_cents),
    payment_method: v.oneOf(body.payment_method, PAYMENT_METHODS, 'forma de pagamento'),
    type: body.type === undefined ? (category.default_expense_type ?? 'OUTRA') : v.oneOf(body.type, EXPENSE_TYPES, 'tipo'),
    ...schedule(body),
    start_date: start,
    end_date: endDate(body.end_date ?? null, start, tz),
  };
  const active = await env.DB.prepare('SELECT COUNT(*) AS n FROM recurring_expenses WHERE tenant_id = ? AND active = 1').bind(auth.tenantId).first();
  if (active.n >= MAX_ACTIVE_PER_TENANT) throw errors.invalidState('Limite de despesas recorrentes ativas atingido. Pause alguma antes de criar outra.');

  const names = Object.keys(data);
  const [inserted] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO recurring_expenses (tenant_id, created_by, ${names.join(', ')}) VALUES (?, ?, ${names.map(() => '?').join(', ')}) RETURNING id`)
      .bind(auth.tenantId, auth.userId, ...names.map((n) => data[n])),
    await auditStatement(env, {
      tenantId: auth.tenantId, actor: actorOf(auth), action: 'RECURRING_CREATED', entity: 'recurring_expense', entityId: null,
      details: { description: data.description, amount_cents: data.amount_cents, frequency: data.frequency, start_date: start },
      ip,
    }),
  ]);
  await generateDue(env, { tenantId: auth.tenantId }); // se começa hoje, já lança hoje
  return ok(present(await findOne(env, auth, String(inserted.results[0].id)), todayIso), 201);
}

export async function updateRecurring({ request, env, auth, params, ip }) {
  const current = await findOne(env, auth, params.id);
  const body = v.onlyFields(await readJson(request), ['category_id', 'description', 'amount_cents', 'payment_method', 'type', 'frequency', 'weekday', 'month_day', 'end_date', 'active']);
  const tz = timeZone(env);
  const todayIso = today(tz);
  const changes = {};
  if (body.category_id !== undefined && v.bodyId(body.category_id, 'categoria') !== current.category_id) {
    changes.category_id = (await requireActiveCategory(env, auth.tenantId, v.bodyId(body.category_id, 'categoria'), 'DESPESA')).id;
  }
  if (body.description !== undefined) changes.description = v.optionalText(body.description, { field: 'descrição', max: 120 });
  if (body.amount_cents !== undefined) changes.amount_cents = v.cents(body.amount_cents);
  if (body.payment_method !== undefined) changes.payment_method = v.oneOf(body.payment_method, PAYMENT_METHODS, 'forma de pagamento');
  if (body.type !== undefined) changes.type = v.oneOf(body.type, EXPENSE_TYPES, 'tipo');
  if (body.frequency !== undefined || body.weekday !== undefined || body.month_day !== undefined) Object.assign(changes, schedule(body, current));
  if (body.end_date !== undefined) changes.end_date = endDate(body.end_date, current.start_date, tz);
  if (body.active !== undefined) {
    changes.active = v.bool(body.active, 'ativa') ? 1 : 0;
    // Ao retomar, os dias parados não são lançados de uma vez: segue a partir de hoje.
    if (changes.active === 1 && current.active === 0) {
      const yesterday = addDays(todayIso, -1);
      if (!current.last_generated_date || current.last_generated_date < yesterday) changes.last_generated_date = yesterday;
    }
  }
  const columns = Object.keys(changes);
  if (!columns.length) throw errors.validation('Nada para alterar.');

  const before = Object.fromEntries(columns.filter((c) => c !== 'last_generated_date').map((c) => [c, current[c]]));
  const after = Object.fromEntries(columns.filter((c) => c !== 'last_generated_date').map((c) => [c, changes[c]]));
  await env.DB.batch([
    env.DB.prepare(`UPDATE recurring_expenses SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND tenant_id = ?`)
      .bind(...columns.map((c) => changes[c]), new Date().toISOString(), current.id, auth.tenantId),
    await auditStatement(env, {
      tenantId: auth.tenantId, actor: actorOf(auth), action: 'RECURRING_UPDATED', entity: 'recurring_expense', entityId: current.id,
      details: { description: current.description, before, after }, ip,
    }),
  ]);
  await generateDue(env, { tenantId: auth.tenantId });
  return ok(present(await findOne(env, auth, String(current.id)), todayIso));
}
