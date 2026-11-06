// Financeiro do sistema (somente administrador do sistema): quem pagou, quem está atrasado, plano de cada lava-jato,
// registro e estorno de pagamentos e cancelamento da assinatura. Sem cobrança automática: o pagamento é registrado à mão.

import { ok, readJson, errors } from './lib/http.js';
import * as v from './lib/validate.js';
import { today, addMonths, isValidDate, MIN_DATE } from './lib/dates.js';
import { billingState, SUBSCRIPTION_STATUSES } from './lib/billing.js';
import { auditStatement, actorOf, LAST_INSERT_ID } from './audit.js';
import { timeZone } from './entries.js';

const METHODS = ['PIX', 'DINHEIRO', 'TRANSFERENCIA', 'CARTAO', 'OUTRO'];
const FILTERS = ['TODOS', 'ATENCAO', 'EM_DIA', 'VENCENDO', 'EM_ATRASO', 'VENCIDA', 'TESTE', 'CANCELADA', 'ISENTA'];
const MAX_PRICE_CENTS = 100_000_000;
const MAX_TENANTS = 500;

const TENANT_SELECT = `SELECT t.id, t.business_name, t.phone, t.status, t.plan_price_cents, t.subscription_status, t.paid_until,
       t.subscription_cancelled_at, t.subscription_cancel_reason, u.name AS owner_name, u.email
  FROM tenants t LEFT JOIN users u ON u.id = (SELECT MIN(id) FROM users WHERE tenant_id = t.id AND role = 'ADMIN')`;

const present = (row, todayIso) => ({ ...row, billing: billingState(row, todayIso) });

async function findTenant(env, idParam) {
  const row = await env.DB.prepare(`${TENANT_SELECT} WHERE t.id = ?`).bind(v.id(idParam)).first();
  if (!row) throw errors.notFound('Cliente não encontrado.');
  if (row.status === 'PENDENTE') throw errors.invalidState('Autorize o cliente antes de cuidar da mensalidade.');
  return row;
}

/* Painel -------------------------------------------------------------------------------- */

export async function listBilling({ env, url }) {
  const filter = url.searchParams.get('state') ?? 'TODOS';
  v.oneOf(filter, FILTERS, 'situação');
  const pattern = v.likePattern(url.searchParams.get('q'));
  const todayIso = today(timeZone(env));
  const month = todayIso.slice(0, 7);

  const [tenants, received] = await env.DB.batch([
    env.DB.prepare(`${TENANT_SELECT} WHERE t.status <> 'PENDENTE' ORDER BY t.business_name COLLATE NOCASE LIMIT ?`).bind(MAX_TENANTS),
    env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n FROM subscription_payments WHERE status = 'ATIVO' AND substr(paid_on, 1, 7) = ?").bind(month),
  ]);

  const all = tenants.results.map((row) => present(row, todayIso));
  const counts = Object.fromEntries(FILTERS.map((f) => [f, 0]));
  let mrr = 0;
  for (const t of all) {
    counts.TODOS += 1;
    counts[t.billing.state] += 1;
    if (['VENCIDA', 'EM_ATRASO', 'VENCENDO'].includes(t.billing.state)) counts.ATENCAO += 1;
    if (t.subscription_status === 'ATIVA' && t.billing.access) mrr += t.plan_price_cents;
  }
  const match = (t) => {
    if (filter === 'TODOS') return true;
    if (filter === 'ATENCAO') return ['VENCIDA', 'EM_ATRASO', 'VENCENDO'].includes(t.billing.state);
    return t.billing.state === filter;
  };
  const term = pattern ? pattern.replace(/\\([\\%_])/g, '$1').replace(/^%|%$/g, '').toLowerCase() : null;
  const items = all.filter(match)
    .filter((t) => !term || `${t.business_name} ${t.owner_name ?? ''} ${t.email ?? ''}`.toLowerCase().includes(term))
    // Atrasados primeiro, depois quem vence antes.
    .sort((a, b) => (a.billing.days_left ?? 99_999) - (b.billing.days_left ?? 99_999) || a.business_name.localeCompare(b.business_name));
  return ok({ today: todayIso, items, counts, summary: { mrr_cents: mrr, received_month_cents: received.results[0].total, payments_month: received.results[0].n } });
}

export async function listPayments({ env, params }) {
  const tenant = await findTenant(env, params.id);
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.amount_cents, p.months, p.paid_on, p.method, p.note, p.period_start, p.period_end, p.status, p.reversed_at, p.reversed_reason, p.created_at, a.name AS registered_by
       FROM subscription_payments p JOIN system_admins a ON a.id = p.created_by
      WHERE p.tenant_id = ? ORDER BY p.id DESC LIMIT 60`,
  ).bind(tenant.id).all();
  const latest = results.find((p) => p.status === 'ATIVO');
  return ok({ items: results.map((p) => ({ ...p, can_reverse: p.id === latest?.id && p.period_end === tenant.paid_until })) });
}

/* Pagamento ------------------------------------------------------------------------------ */

export async function registerPayment({ request, env, auth, params, ip }) {
  const tenant = await findTenant(env, params.id);
  const body = v.onlyFields(await readJson(request), ['amount_cents', 'months', 'paid_on', 'method', 'note']);
  const tz = timeZone(env);
  const todayIso = today(tz);
  if (tenant.subscription_status === 'ISENTA') throw errors.invalidState('Este cliente é isento de mensalidade. Tire a isenção em "Plano" antes de registrar pagamentos.');

  const months = body.months === undefined ? 1 : body.months;
  if (!Number.isInteger(months) || months < 1 || months > 12) throw errors.validation('Informe de 1 a 12 meses.');
  const paidOn = body.paid_on === undefined ? todayIso : body.paid_on;
  if (!isValidDate(paidOn) || paidOn < MIN_DATE || paidOn > todayIso) throw errors.validation('A data do pagamento não pode ser futura.');
  const data = {
    amount_cents: v.cents(body.amount_cents),
    method: v.oneOf(body.method ?? 'PIX', METHODS, 'forma de pagamento'),
    note: v.optionalText(body.note, { field: 'a observação', max: 200 }),
  };

  // Renova a partir do vencimento atual (se ainda vale) ou de hoje (se já venceu).
  const base = tenant.paid_until && tenant.paid_until >= todayIso ? tenant.paid_until : todayIso;
  const paidUntil = addMonths(base, months);
  const [inserted, update] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscription_payments (tenant_id, amount_cents, months, paid_on, method, note, period_start, period_end, prev_paid_until, prev_status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(tenant.id, data.amount_cents, months, paidOn, data.method, data.note, base, paidUntil, tenant.paid_until, tenant.subscription_status, auth.adminId),
    env.DB.prepare("UPDATE tenants SET paid_until = ?, subscription_status = 'ATIVA', updated_at = ? WHERE id = ?").bind(paidUntil, new Date().toISOString(), tenant.id),
    await auditStatement(env, {
      tenantId: tenant.id, actor: actorOf(auth), action: 'PAYMENT_REGISTERED', entity: 'subscription_payment', entityId: LAST_INSERT_ID,
      details: { business_name: tenant.business_name, amount_cents: data.amount_cents, months, paid_until: paidUntil }, ip,
    }),
  ]);
  if (update.meta.changes !== 1) throw errors.notFound('Cliente não encontrado.');
  const fresh = await findTenant(env, String(tenant.id));
  return ok({ payment_id: inserted.results[0].id, tenant: present(fresh, todayIso) }, 201);
}

/** Estorno: só do último pagamento, e só se o vencimento ainda for o que ele gerou (nada ajustado à mão depois). */
export async function reversePayment({ request, env, auth, params, ip }) {
  const body = v.onlyFields(await readJson(request), ['reason']);
  const reason = v.optionalText(body.reason, { field: 'o motivo', max: 200 });
  const payment = await env.DB.prepare('SELECT * FROM subscription_payments WHERE id = ?').bind(v.id(params.id)).first();
  if (!payment) throw errors.notFound('Pagamento não encontrado.');
  if (payment.status !== 'ATIVO') throw errors.invalidState('Este pagamento já foi estornado.');
  const tenant = await findTenant(env, String(payment.tenant_id));
  const later = await env.DB.prepare("SELECT 1 FROM subscription_payments WHERE tenant_id = ? AND status = 'ATIVO' AND id > ?").bind(payment.tenant_id, payment.id).first();
  if (later) throw errors.invalidState('Só o último pagamento pode ser estornado. Estorne primeiro os mais recentes.');
  if (tenant.paid_until !== payment.period_end) throw errors.invalidState('O vencimento foi alterado depois deste pagamento. Ajuste o vencimento em "Plano".');

  const now = new Date().toISOString();
  const [mark, restore] = await env.DB.batch([
    env.DB.prepare("UPDATE subscription_payments SET status = 'ESTORNADO', reversed_at = ?, reversed_reason = ? WHERE id = ? AND status = 'ATIVO'").bind(now, reason, payment.id),
    env.DB.prepare('UPDATE tenants SET paid_until = ?, subscription_status = ?, updated_at = ? WHERE id = ?').bind(payment.prev_paid_until, payment.prev_status, now, payment.tenant_id),
    await auditStatement(env, {
      tenantId: payment.tenant_id, actor: actorOf(auth), action: 'PAYMENT_REVERSED', entity: 'subscription_payment', entityId: payment.id,
      details: { business_name: tenant.business_name, amount_cents: payment.amount_cents, reason, paid_until: payment.prev_paid_until }, ip, onlyIfChanged: true,
    }),
  ]);
  if (mark.meta.changes !== 1 || restore.meta.changes !== 1) throw errors.invalidState('Este pagamento já foi estornado.');
  return ok({ tenant: present(await findTenant(env, String(payment.tenant_id)), today(timeZone(env))) });
}

/* Plano, cancelamento e reativação -------------------------------------------------------- */

export async function updatePlan({ request, env, auth, params, ip }) {
  const tenant = await findTenant(env, params.id);
  const body = v.onlyFields(await readJson(request), ['plan_price_cents', 'exempt', 'paid_until']);
  const todayIso = today(timeZone(env));
  const changes = {};
  if (body.plan_price_cents !== undefined) {
    if (!Number.isInteger(body.plan_price_cents) || body.plan_price_cents < 0 || body.plan_price_cents > MAX_PRICE_CENTS) throw errors.validation('Valor da mensalidade inválido.');
    changes.plan_price_cents = body.plan_price_cents;
  }
  if (body.paid_until !== undefined) {
    if (!isValidDate(body.paid_until) || body.paid_until < '2020-01-01' || body.paid_until > addMonths(todayIso, 60)) throw errors.validation('Vencimento inválido.');
    changes.paid_until = body.paid_until;
  }
  if (body.exempt !== undefined) {
    const exempt = v.bool(body.exempt, 'isento');
    if (exempt && tenant.subscription_status !== 'ISENTA') changes.subscription_status = 'ISENTA';
    if (!exempt && tenant.subscription_status === 'ISENTA') changes.subscription_status = 'ATIVA';
  }
  if (!Object.keys(body).length) throw errors.validation('Nada para alterar.');
  const columns = Object.keys(changes).filter((c) => changes[c] !== tenant[c]);
  if (columns.length) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE tenants SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).bind(...columns.map((c) => changes[c]), new Date().toISOString(), tenant.id),
      await auditStatement(env, {
        tenantId: tenant.id, actor: actorOf(auth), action: 'PLAN_CHANGED', entity: 'tenant', entityId: tenant.id,
        details: { business_name: tenant.business_name, before: Object.fromEntries(columns.map((c) => [c, tenant[c]])), after: Object.fromEntries(columns.map((c) => [c, changes[c]])) }, ip,
      }),
    ]);
  }
  return ok(present(await findTenant(env, String(tenant.id)), todayIso));
}

/** Cancela a assinatura: não renova e o acesso vale até a data já paga. `block_now` também bloqueia e desconecta agora. */
export async function cancelSubscription({ request, env, auth, params, ip }) {
  const tenant = await findTenant(env, params.id);
  const body = v.onlyFields(await readJson(request), ['reason', 'block_now']);
  const reason = v.optionalText(body.reason, { field: 'o motivo', max: 200 });
  const blockNow = body.block_now === undefined ? false : v.bool(body.block_now, 'bloquear agora');
  if (tenant.subscription_status === 'CANCELADA') throw errors.invalidState('A assinatura já está cancelada.');
  if (tenant.subscription_status === 'ISENTA') throw errors.invalidState('Este cliente é isento: não há assinatura para cancelar.');

  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare("UPDATE tenants SET subscription_status = 'CANCELADA', subscription_cancelled_at = ?1, subscription_cancel_reason = ?2, updated_at = ?1 WHERE id = ?3 AND subscription_status <> 'CANCELADA'").bind(now, reason, tenant.id),
    await auditStatement(env, {
      tenantId: tenant.id, actor: actorOf(auth), action: 'SUBSCRIPTION_CANCELLED', entity: 'tenant', entityId: tenant.id,
      details: { business_name: tenant.business_name, reason, paid_until: tenant.paid_until, blocked_now: blockNow }, ip, onlyIfChanged: true,
    }),
  ];
  if (blockNow) {
    statements.push(env.DB.prepare("UPDATE tenants SET status = 'BLOQUEADO', blocked_at = ? WHERE id = ? AND status = 'ATIVO'").bind(now, tenant.id));
    statements.push(env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL').bind(now, tenant.id));
  }
  const [update] = await env.DB.batch(statements);
  if (update.meta.changes !== 1) throw errors.invalidState('A assinatura já está cancelada.');
  return ok(present(await findTenant(env, String(tenant.id)), today(timeZone(env))));
}

/** Reativa uma assinatura cancelada. Se a data paga já passou, o acesso só volta com um novo pagamento. */
export async function reactivateSubscription({ env, auth, params, ip }) {
  const tenant = await findTenant(env, params.id);
  if (tenant.subscription_status !== 'CANCELADA') throw errors.invalidState('Só dá para reativar uma assinatura cancelada.');
  await env.DB.batch([
    env.DB.prepare("UPDATE tenants SET subscription_status = 'ATIVA', subscription_cancelled_at = NULL, subscription_cancel_reason = '', updated_at = ? WHERE id = ? AND subscription_status = 'CANCELADA'").bind(new Date().toISOString(), tenant.id),
    await auditStatement(env, {
      tenantId: tenant.id, actor: actorOf(auth), action: 'SUBSCRIPTION_REACTIVATED', entity: 'tenant', entityId: tenant.id,
      details: { business_name: tenant.business_name, paid_until: tenant.paid_until }, ip, onlyIfChanged: true,
    }),
  ]);
  return ok(present(await findTenant(env, String(tenant.id)), today(timeZone(env))));
}

export { SUBSCRIPTION_STATUSES };
