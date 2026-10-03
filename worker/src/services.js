// Serviços do lava-jato: cadastro (ADMIN), preço e composição estimada do custo.
// Custo estimado = consumo de produtos (quantidade × custo médio) + valores fixos rateados.
// É sempre uma ESTIMATIVA: depende do custo médio atual e dos rateios informados.

import { ok, readJson, errors } from './lib/http.js';
import * as v from './lib/validate.js';
import { ratioBp } from './lib/finance.js';
import { auditStatement, actorOf, LAST_INSERT_ID } from './audit.js';

const MAX_COST_ITEMS = 20;
const MAX_QTY = 1_000_000_000;

/** Custo estimado por serviço (em centavos) para vários serviços de uma vez. */
async function estimatesFor(env, tenantId, serviceId = null) {
  const { results } = await env.DB.prepare(
    `SELECT sc.service_id,
            SUM(sc.fixed_cost_cents) * 10000 + SUM(sc.qty * COALESCE(p.avg_cost_micro, 0)) AS micro,
            SUM(CASE WHEN sc.product_id IS NULL THEN 1 ELSE 0 END) AS fixed_items
       FROM service_costs sc
       LEFT JOIN products p ON p.tenant_id = sc.tenant_id AND p.id = sc.product_id
      WHERE sc.tenant_id = ?1 AND (?2 IS NULL OR sc.service_id = ?2)
      GROUP BY sc.service_id`,
  ).bind(tenantId, serviceId).all();
  return new Map(results.map((r) => [r.service_id, { cents: Math.round(r.micro / 10_000), hasAllocation: r.fixed_items > 0 }]));
}

function withEstimate(service, estimate) {
  const cost = estimate?.cents ?? 0;
  return {
    ...service,
    estimated_cost_cents: cost,
    estimated_margin_cents: service.price_cents - cost,
    estimated_margin_bp: ratioBp(service.price_cents - cost, service.price_cents),
    has_cost_composition: Boolean(estimate),
  };
}

/** Custo estimado de um serviço, em centavos (usado ao gravar o custo da venda na receita). */
export async function estimateServiceCostCents(env, tenantId, serviceId) {
  return (await estimatesFor(env, tenantId, serviceId)).get(serviceId)?.cents ?? 0;
}

/** Serviço ativo do próprio lava-jato; usado ao validar receitas. */
export async function requireActiveService(env, tenantId, serviceId) {
  const row = await env.DB.prepare('SELECT id, name, price_cents FROM services WHERE id = ? AND tenant_id = ? AND active = 1')
    .bind(serviceId, tenantId).first();
  if (!row) throw errors.validation('Serviço inválido.');
  return row;
}

async function findService(env, auth, idParam) {
  const row = await env.DB.prepare('SELECT id, name, price_cents, active FROM services WHERE id = ? AND tenant_id = ?')
    .bind(v.id(idParam), auth.tenantId).first();
  if (!row) throw errors.notFound('Serviço não encontrado.');
  return { ...row, active: row.active === 1 };
}

/* Consulta ------------------------------------------------------------------------ */

export async function listServices({ env, auth, url }) {
  const isAdmin = auth.role === 'ADMIN';
  const includeInactive = isAdmin && url.searchParams.get('include_inactive') === '1';
  const { results } = await env.DB.prepare(
    `SELECT id, name, price_cents, active FROM services WHERE tenant_id = ? AND (? = 1 OR active = 1)
      ORDER BY active DESC, name COLLATE NOCASE LIMIT 200`,
  ).bind(auth.tenantId, includeInactive ? 1 : 0).all();
  const items = results.map((s) => ({ ...s, active: s.active === 1 }));
  if (!isAdmin) return ok({ items });
  // Custos e margens são gerenciais: só para ADMIN.
  const estimates = await estimatesFor(env, auth.tenantId);
  return ok({ items: items.map((s) => withEstimate(s, estimates.get(s.id))) });
}

/** Serviço com composição de custo e estimativas (ADMIN) ou só nome e preço (OPERADOR). */
async function serviceDetail(env, auth, idParam) {
  const service = await findService(env, auth, idParam);
  if (auth.role !== 'ADMIN') return service;
  const { results } = await env.DB.prepare(
    `SELECT sc.id, sc.product_id, p.name AS product_name, p.unit, sc.description, sc.qty, sc.fixed_cost_cents,
            CAST(ROUND(sc.qty * COALESCE(p.avg_cost_micro, 0) / 10000.0) AS INTEGER) + sc.fixed_cost_cents AS cost_cents
       FROM service_costs sc LEFT JOIN products p ON p.tenant_id = sc.tenant_id AND p.id = sc.product_id
      WHERE sc.tenant_id = ? AND sc.service_id = ? ORDER BY sc.id`,
  ).bind(auth.tenantId, service.id).all();
  const estimates = await estimatesFor(env, auth.tenantId, service.id);
  return { ...withEstimate(service, estimates.get(service.id)), costs: results };
}

export async function getService({ env, auth, params }) {
  return ok(await serviceDetail(env, auth, params.id));
}

/* Cadastro (ADMIN) ------------------------------------------------------------------ */

const duplicate = (error) => String(error?.message).includes('UNIQUE');

export async function createService({ request, env, auth, ip }) {
  const body = v.onlyFields(await readJson(request), ['name', 'price_cents']);
  const data = { name: v.text(body.name, { field: 'o nome', min: 1, max: 60 }), price_cents: v.cents(body.price_cents, 'preço') };
  let created;
  try {
    [created] = (await env.DB.batch([
      env.DB.prepare('INSERT INTO services (tenant_id, name, price_cents) VALUES (?, ?, ?) RETURNING id').bind(auth.tenantId, data.name, data.price_cents),
      await auditStatement(env, { tenantId: auth.tenantId, actor: actorOf(auth), action: 'SERVICE_CREATED', entity: 'service', entityId: LAST_INSERT_ID, details: data, ip }),
    ]))[0].results;
  } catch (error) {
    if (duplicate(error)) throw errors.conflict('Já existe um serviço com este nome.');
    throw error;
  }
  return ok(await serviceDetail(env, auth, String(created.id)), 201);
}

export async function updateService({ request, env, auth, params, ip }) {
  const current = await findService(env, auth, params.id);
  const body = v.onlyFields(await readJson(request), ['name', 'price_cents', 'active']);
  const changes = {};
  if (body.name !== undefined) changes.name = v.text(body.name, { field: 'o nome', min: 1, max: 60 });
  if (body.price_cents !== undefined) changes.price_cents = v.cents(body.price_cents, 'preço');
  if (body.active !== undefined) changes.active = v.bool(body.active, 'ativo') ? 1 : 0;
  const columns = Object.keys(changes).filter((c) => changes[c] !== (c === 'active' ? Number(current.active) : current[c]));
  if (!columns.length) return ok(await serviceDetail(env, auth, params.id));

  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE services SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND tenant_id = ?`)
        .bind(...columns.map((c) => changes[c]), new Date().toISOString(), current.id, auth.tenantId),
      await auditStatement(env, {
        tenantId: auth.tenantId,
        actor: actorOf(auth),
        // Alteração de preço tem ação própria para ser fácil de encontrar na auditoria.
        action: columns.includes('price_cents') ? 'SERVICE_PRICE_CHANGED' : 'SERVICE_UPDATED',
        entity: 'service',
        entityId: current.id,
        details: { before: Object.fromEntries(columns.map((c) => [c, current[c]])), after: Object.fromEntries(columns.map((c) => [c, changes[c]])) },
        ip,
      }),
    ]);
  } catch (error) {
    if (duplicate(error)) throw errors.conflict('Já existe um serviço com este nome.');
    throw error;
  }
  return ok(await serviceDetail(env, auth, params.id));
}

/**
 * Substitui a composição de custo. Cada item é:
 *   { product_id, qty }                       consumo de produto (qty na menor unidade)
 *   { description, fixed_cost_cents }         valor rateado (água, energia, outros)
 */
export async function replaceServiceCosts({ request, env, auth, params, ip }) {
  const service = await findService(env, auth, params.id);
  const body = v.onlyFields(await readJson(request), ['items']);
  if (!Array.isArray(body.items) || body.items.length > MAX_COST_ITEMS) throw errors.validation(`Informe até ${MAX_COST_ITEMS} itens de custo.`);

  const productIds = [];
  const items = body.items.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw errors.validation('Item de custo inválido.');
    v.onlyFields(raw, ['product_id', 'qty', 'description', 'fixed_cost_cents']);
    if (raw.product_id !== undefined && raw.product_id !== null) {
      const productId = v.bodyId(raw.product_id, 'produto');
      if (!Number.isSafeInteger(raw.qty) || raw.qty < 1 || raw.qty > MAX_QTY) throw errors.validation('Quantidade de produto inválida.');
      productIds.push(productId);
      return { product_id: productId, qty: raw.qty, description: v.optionalText(raw.description, { field: 'descrição', max: 60 }), fixed_cost_cents: 0 };
    }
    return {
      product_id: null,
      qty: 0,
      description: v.text(raw.description, { field: 'a descrição do custo', min: 1, max: 60 }),
      fixed_cost_cents: v.cents(raw.fixed_cost_cents, 'valor do custo'),
    };
  });

  // Produtos precisam ser do próprio lava-jato e estar ativos.
  const names = new Map();
  if (productIds.length) {
    const unique = [...new Set(productIds)];
    const { results } = await env.DB.prepare(
      `SELECT id, name FROM products WHERE tenant_id = ? AND active = 1 AND id IN (${unique.map(() => '?').join(', ')})`,
    ).bind(auth.tenantId, ...unique).all();
    results.forEach((p) => names.set(p.id, p.name));
    if (names.size !== unique.length) throw errors.validation('Produto inválido na composição.');
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM service_costs WHERE tenant_id = ? AND service_id = ?').bind(auth.tenantId, service.id),
    ...items.map((item) => env.DB.prepare(
      `INSERT INTO service_costs (tenant_id, service_id, product_id, description, qty, fixed_cost_cents, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(auth.tenantId, service.id, item.product_id, item.description || names.get(item.product_id), item.qty, item.fixed_cost_cents, now)),
    await auditStatement(env, {
      tenantId: auth.tenantId, actor: actorOf(auth), action: 'SERVICE_COSTS_CHANGED', entity: 'service', entityId: service.id,
      details: { items: items.map((i) => ({ product_id: i.product_id, qty: i.qty, description: i.description, fixed_cost_cents: i.fixed_cost_cents })) },
      ip,
    }),
  ]);
  return ok(await serviceDetail(env, auth, params.id));
}
