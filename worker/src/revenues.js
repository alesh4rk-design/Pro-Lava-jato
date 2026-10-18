// Receitas. Registrar: ADMIN e OPERADOR. Editar e cancelar: só ADMIN.

import { readJson, errors } from './lib/http.js';
import * as v from './lib/validate.js';
import { parseCommon, insertEntry, listEntries, getEntry, findEntry, applyUpdate, cancelEntry } from './entries.js';
import { requireActiveService, estimateServiceCostCents } from './services.js';
import { requireActiveCustomer } from './customers.js';

const ledger = {
  table: 'revenues',
  alias: 'r',
  entity: 'revenue',
  label: 'Receita',
  select: `SELECT r.id, r.date, r.service_id, s.name AS service_name, r.description, r.amount_cents, r.payment_method,
                  r.notes, r.service_cost_snapshot_cents, r.customer_id, cust.name AS customer_name, r.status, r.cancel_reason, r.cancelled_at, cu.name AS cancelled_by_name,
                  u.name AS user_name, r.created_at, r.updated_at
             FROM revenues r
             JOIN users u ON u.id = r.user_id
             LEFT JOIN services s ON s.tenant_id = r.tenant_id AND s.id = r.service_id
             LEFT JOIN customers cust ON cust.tenant_id = r.tenant_id AND cust.id = r.customer_id
             LEFT JOIN users cu ON cu.id = r.cancelled_by`,
  searchColumns: ['r.description', 'r.notes', 's.name', 'cust.name'],
  refFilter: { param: 'service_id', column: 'service_id' },
  // Custo estimado é informação gerencial: não vai para o operador.
  adminOnlyFields: ['service_cost_snapshot_cents'],
};

const FIELDS = ['date', 'amount_cents', 'payment_method', 'description', 'notes', 'service_id', 'customer_id'];

/** Serviço opcional; sem serviço, a descrição é obrigatória. Guarda o custo estimado do momento. */
async function resolveService(env, auth, serviceId, description) {
  if (serviceId === null) {
    if (!description) throw errors.validation('Informe o serviço ou uma descrição.');
    return { service_id: null, service_cost_snapshot_cents: 0 };
  }
  await requireActiveService(env, auth.tenantId, serviceId);
  return { service_id: serviceId, service_cost_snapshot_cents: await estimateServiceCostCents(env, auth.tenantId, serviceId) };
}

export async function createRevenue(ctx) {
  const body = v.onlyFields(await readJson(ctx.request), FIELDS);
  const data = parseCommon(body, ctx.env);
  const service = await resolveService(ctx.env, ctx.auth, v.optionalBodyId(body.service_id, 'serviço'), data.description);
  // Cliente que fez a limpeza (opcional): precisa ser um cliente ativo deste lava-jato.
  const customerId = v.optionalBodyId(body.customer_id, 'cliente');
  if (customerId !== null) await requireActiveCustomer(ctx.env, ctx.auth.tenantId, customerId);
  return await insertEntry(ledger, ctx, { ...data, ...service, customer_id: customerId });
}

export async function updateRevenue(ctx) {
  const current = await findEntry(ledger, ctx.env, ctx.auth, ctx.params.id);
  const body = v.onlyFields(await readJson(ctx.request), FIELDS);
  const changes = parseCommon(body, ctx.env, { partial: true });

  const description = changes.description ?? current.description;
  const serviceId = body.service_id === undefined ? current.service_id : v.optionalBodyId(body.service_id, 'serviço');
  if (serviceId !== current.service_id) {
    Object.assign(changes, await resolveService(ctx.env, ctx.auth, serviceId, description));
  } else if (serviceId === null && !description) {
    throw errors.validation('Informe o serviço ou uma descrição.');
  }
  if (body.customer_id !== undefined) {
    const customerId = v.optionalBodyId(body.customer_id, 'cliente');
    if (customerId !== current.customer_id) {
      if (customerId !== null) await requireActiveCustomer(ctx.env, ctx.auth.tenantId, customerId);
      changes.customer_id = customerId;
    }
  }
  return await applyUpdate(ledger, ctx, current, changes);
}

export const listRevenues = (ctx) => listEntries(ledger, ctx);
export const getRevenue = (ctx) => getEntry(ledger, ctx);
export const cancelRevenue = (ctx) => cancelEntry(ledger, ctx);
