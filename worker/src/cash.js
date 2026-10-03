// Fluxo de caixa: entradas (receitas) e saídas (despesas) ativas do período, por forma de pagamento,
// e a lista unificada de lançamentos.

import { ok } from './lib/http.js';
import * as v from './lib/validate.js';
import { resolvePeriod } from './lib/dates.js';
import { PAYMENT_METHODS, timeZone } from './entries.js';

const PAGE_SIZE = 50;

export async function cashSummary({ env, auth, url }) {
  const period = resolvePeriod(url.searchParams, timeZone(env));
  const byMethod = (table) => env.DB.prepare(
    `SELECT payment_method, SUM(amount_cents) AS total, COUNT(*) AS n FROM ${table}
      WHERE tenant_id = ? AND status = 'ATIVO' AND date BETWEEN ? AND ? GROUP BY payment_method`,
  ).bind(auth.tenantId, period.start, period.end);

  const [revenues, expenses] = await env.DB.batch([byMethod('revenues'), byMethod('expenses')]);
  const methods = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, { in_cents: 0, out_cents: 0, count: 0 }]));
  revenues.results.forEach((r) => { methods[r.payment_method].in_cents = r.total; methods[r.payment_method].count += r.n; });
  expenses.results.forEach((r) => { methods[r.payment_method].out_cents = r.total; methods[r.payment_method].count += r.n; });

  const inCents = revenues.results.reduce((sum, r) => sum + r.total, 0);
  const outCents = expenses.results.reduce((sum, r) => sum + r.total, 0);
  return ok({
    period,
    totals: { in_cents: inCents, out_cents: outCents, balance_cents: inCents - outCents },
    by_method: PAYMENT_METHODS.map((method) => ({ method, ...methods[method] })),
  });
}

export async function cashEntries({ env, auth, url }) {
  const params = url.searchParams;
  const period = resolvePeriod(params, timeZone(env));
  const method = params.get('payment_method') ? v.oneOf(params.get('payment_method'), PAYMENT_METHODS, 'forma de pagamento') : null;
  const kind = params.get('kind') ? v.oneOf(params.get('kind'), ['IN', 'OUT'], 'tipo') : null;
  const includeCancelled = params.get('include_cancelled') === '1' ? 1 : 0;
  const pattern = v.likePattern(params.get('q'));
  const page = v.page(params);

  // Mesmos filtros nas duas partes do UNION; parâmetros numerados evitam repetir binds.
  const filters = `x.tenant_id = ?1 AND x.date BETWEEN ?2 AND ?3 AND (?4 IS NULL OR x.payment_method = ?4)
                   AND (?5 = 1 OR x.status = 'ATIVO')`;
  const search = (ref) => `AND (?6 IS NULL OR x.description LIKE ?6 ESCAPE '\\' OR x.notes LIKE ?6 ESCAPE '\\' OR ${ref} LIKE ?6 ESCAPE '\\')`;

  const { results } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT 'IN' AS kind, x.id, x.date, x.amount_cents, x.payment_method, x.status, x.description,
              s.name AS ref_name, x.created_at
         FROM revenues x LEFT JOIN services s ON s.tenant_id = x.tenant_id AND s.id = x.service_id
        WHERE ?7 IN ('ALL', 'IN') AND ${filters} ${search('s.name')}
       UNION ALL
       SELECT 'OUT' AS kind, x.id, x.date, x.amount_cents, x.payment_method, x.status, x.description,
              c.name AS ref_name, x.created_at
         FROM expenses x JOIN categories c ON c.tenant_id = x.tenant_id AND c.id = x.category_id
        WHERE ?7 IN ('ALL', 'OUT') AND ${filters} ${search('c.name')}
     )
     ORDER BY date DESC, created_at DESC, id DESC
     LIMIT ?8 OFFSET ?9`,
  ).bind(auth.tenantId, period.start, period.end, method, includeCancelled, pattern, kind ?? 'ALL', PAGE_SIZE + 1, (page - 1) * PAGE_SIZE).all();

  return ok({ period, items: results.slice(0, PAGE_SIZE), page, has_more: results.length > PAGE_SIZE });
}
