// Serviços do lava-jato. Nesta etapa: listagem (usada no lançamento de receitas) e o custo estimado.
// O cadastro e a composição de custos chegam na Etapa 4.

import { ok, errors } from './lib/http.js';

export async function listServices({ env, auth }) {
  const { results } = await env.DB.prepare(
    'SELECT id, name, price_cents FROM services WHERE tenant_id = ? AND active = 1 ORDER BY name COLLATE NOCASE LIMIT 200',
  ).bind(auth.tenantId).all();
  return ok({ items: results });
}

/**
 * Custo estimado de um serviço, em centavos: valores fixos rateados + consumo de produtos
 * (quantidade × custo médio em micro-reais). 1 centavo = 10.000 micro-reais.
 * Arredonda uma única vez, no total.
 */
export async function estimateServiceCostCents(env, tenantId, serviceId) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(sc.fixed_cost_cents), 0) * 10000 + COALESCE(SUM(sc.qty * COALESCE(p.avg_cost_micro, 0)), 0) AS micro
       FROM service_costs sc
       LEFT JOIN products p ON p.tenant_id = sc.tenant_id AND p.id = sc.product_id
      WHERE sc.tenant_id = ? AND sc.service_id = ?`,
  ).bind(tenantId, serviceId).first();
  return Math.round(row.micro / 10_000);
}

/** Serviço ativo do próprio lava-jato; usado ao validar receitas. */
export async function requireActiveService(env, tenantId, serviceId) {
  const row = await env.DB.prepare('SELECT id, name, price_cents FROM services WHERE id = ? AND tenant_id = ? AND active = 1')
    .bind(serviceId, tenantId).first();
  if (!row) throw errors.validation('Serviço inválido.');
  return row;
}
