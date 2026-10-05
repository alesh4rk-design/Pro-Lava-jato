// Relatórios gerenciais (somente ADMIN). Todos usam lançamentos ATIVOS do período e valores em centavos.

import { ok } from './lib/http.js';
import { resolvePeriod, addDays } from './lib/dates.js';
import { summarize, ratioBp, breakEven } from './lib/finance.js';
import { PAYMENT_METHODS, timeZone } from './entries.js';

const DAY_MS = 86_400_000;
const MAX_DAILY_BUCKETS = 62; // acima disso a série é mensal

const period = (env, url) => resolvePeriod(url.searchParams, timeZone(env));
const daysBetween = (start, end) => Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1;

/** Lista de rótulos do período: dias (AAAA-MM-DD) ou meses (AAAA-MM). */
function buckets(start, end, granularity) {
  const list = [];
  if (granularity === 'day') {
    for (let d = start; d <= end; d = addDays(d, 1)) list.push(d);
  } else {
    let [y, m] = start.slice(0, 7).split('-').map(Number);
    const last = end.slice(0, 7);
    for (let key = start.slice(0, 7); key <= last; key = `${y}-${String(m).padStart(2, '0')}`) {
      list.push(key);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }
  return list;
}

/** Totais do período por tipo de despesa + receitas (mesma regra do dashboard). */
async function periodTotals(env, tenantId, p) {
  const [rev, exp] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n, COUNT(service_id) AS services,
              COALESCE(SUM(service_cost_snapshot_cents), 0) AS estimated_costs
         FROM revenues WHERE tenant_id = ? AND status = 'ATIVO' AND date BETWEEN ? AND ?`,
    ).bind(tenantId, p.start, p.end),
    env.DB.prepare(
      `SELECT type, SUM(amount_cents) AS total FROM expenses
        WHERE tenant_id = ? AND status = 'ATIVO' AND date BETWEEN ? AND ? GROUP BY type`,
    ).bind(tenantId, p.start, p.end),
  ]);
  const byType = Object.fromEntries(exp.results.map((row) => [row.type, row.total]));
  const r = rev.results[0];
  return {
    revenueCents: r.total,
    revenueCount: r.n,
    servicesCount: r.services,
    estimatedServiceCostsCents: r.estimated_costs,
    variableCostsCents: byType.CUSTO_VARIAVEL ?? 0,
    fixedCents: byType.DESPESA_FIXA ?? 0,
    otherCents: byType.OUTRA ?? 0,
  };
}

/* Financeiro: totais, evolução no tempo e formas de pagamento ------------------------ */

export async function financialReport({ env, auth, url }) {
  const p = period(env, url);
  const granularity = daysBetween(p.start, p.end) <= MAX_DAILY_BUCKETS ? 'day' : 'month';
  const bucket = granularity === 'day' ? 'date' : 'substr(date, 1, 7)';

  const [rev, exp, methods] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${bucket} AS bucket, SUM(amount_cents) AS total FROM revenues
        WHERE tenant_id = ? AND status = 'ATIVO' AND date BETWEEN ? AND ? GROUP BY bucket`,
    ).bind(auth.tenantId, p.start, p.end),
    env.DB.prepare(
      `SELECT ${bucket} AS bucket, type, SUM(amount_cents) AS total FROM expenses
        WHERE tenant_id = ? AND status = 'ATIVO' AND date BETWEEN ? AND ? GROUP BY bucket, type`,
    ).bind(auth.tenantId, p.start, p.end),
    env.DB.prepare(
      `SELECT payment_method, SUM(amount_cents) AS total, COUNT(*) AS n FROM revenues
        WHERE tenant_id = ? AND status = 'ATIVO' AND date BETWEEN ? AND ? GROUP BY payment_method`,
    ).bind(auth.tenantId, p.start, p.end),
  ]);

  const series = new Map(buckets(p.start, p.end, granularity).map((key) => [key, { revenue: 0, variable: 0, fixed: 0, other: 0 }]));
  rev.results.forEach((row) => { series.get(row.bucket).revenue = row.total; });
  const typeKey = { CUSTO_VARIAVEL: 'variable', DESPESA_FIXA: 'fixed', OUTRA: 'other' };
  exp.results.forEach((row) => { series.get(row.bucket)[typeKey[row.type]] = row.total; });

  const points = [...series].map(([key, v]) => ({
    bucket: key,
    revenue_cents: v.revenue,
    variable_costs_cents: v.variable,
    expenses_cents: v.fixed + v.other,
    result_cents: v.revenue - v.variable - v.fixed - v.other,
  }));
  const sum = (field) => points.reduce((acc, pt) => acc + pt[field], 0);
  const totalsRaw = await periodTotals(env, auth.tenantId, p);

  const revenueTotal = sum('revenue_cents');
  const byMethod = Object.fromEntries(methods.results.map((row) => [row.payment_method, row]));
  return ok({
    period: p,
    granularity,
    totals: summarize(totalsRaw),
    series: points,
    payment_methods: PAYMENT_METHODS.map((method) => ({
      method,
      total_cents: byMethod[method]?.total ?? 0,
      count: byMethod[method]?.n ?? 0,
      share_bp: revenueTotal ? ratioBp(byMethod[method]?.total ?? 0, revenueTotal) : null,
    })),
  });
}

/* Gastos por categoria --------------------------------------------------------------- */

export async function categoriesReport({ env, auth, url }) {
  const p = period(env, url);
  const { results } = await env.DB.prepare(
    `SELECT c.id AS category_id, c.name,
            SUM(e.amount_cents) AS total_cents, COUNT(*) AS count,
            SUM(CASE WHEN e.type = 'CUSTO_VARIAVEL' THEN e.amount_cents ELSE 0 END) AS variable_costs_cents,
            SUM(CASE WHEN e.type = 'DESPESA_FIXA' THEN e.amount_cents ELSE 0 END) AS fixed_cents,
            SUM(CASE WHEN e.type = 'OUTRA' THEN e.amount_cents ELSE 0 END) AS other_cents
       FROM expenses e JOIN categories c ON c.tenant_id = e.tenant_id AND c.id = e.category_id
      WHERE e.tenant_id = ? AND e.status = 'ATIVO' AND e.date BETWEEN ? AND ?
      GROUP BY c.id ORDER BY total_cents DESC, c.name`,
  ).bind(auth.tenantId, p.start, p.end).all();
  const total = results.reduce((acc, row) => acc + row.total_cents, 0);
  return ok({
    period: p,
    total_cents: total,
    items: results.map((row) => ({ ...row, share_bp: ratioBp(row.total_cents, total) })),
  });
}

/* Por serviço ----------------------------------------------------------------------- */

export async function servicesReport({ env, auth, url }) {
  const p = period(env, url);
  const { results } = await env.DB.prepare(
    `SELECT r.service_id, s.name, COUNT(*) AS count, SUM(r.amount_cents) AS revenue_cents,
            SUM(r.service_cost_snapshot_cents) AS estimated_cost_cents
       FROM revenues r LEFT JOIN services s ON s.tenant_id = r.tenant_id AND s.id = r.service_id
      WHERE r.tenant_id = ? AND r.status = 'ATIVO' AND r.date BETWEEN ? AND ?
      GROUP BY r.service_id ORDER BY revenue_cents DESC`,
  ).bind(auth.tenantId, p.start, p.end).all();
  const total = results.reduce((acc, row) => acc + row.revenue_cents, 0);
  return ok({
    period: p,
    total_revenue_cents: total,
    // Custo e margem vêm do custo estimado gravado em cada venda: são estimativas.
    items: results.map((row) => {
      const margin = row.revenue_cents - row.estimated_cost_cents;
      return {
        service_id: row.service_id,
        name: row.service_id === null ? 'Outras receitas' : row.name,
        count: row.count,
        revenue_cents: row.revenue_cents,
        avg_price_cents: Math.round(row.revenue_cents / row.count),
        estimated_cost_cents: row.service_id === null ? null : row.estimated_cost_cents,
        estimated_margin_cents: row.service_id === null ? null : margin,
        estimated_margin_bp: row.service_id === null ? null : ratioBp(margin, row.revenue_cents),
        share_bp: ratioBp(row.revenue_cents, total),
      };
    }),
  });
}

/* Ponto de equilíbrio ------------------------------------------------------------------- */

export async function breakEvenReport({ env, auth, url }) {
  const p = period(env, url);
  const t = await periodTotals(env, auth.tenantId, p);
  const fixed = t.fixedCents + t.otherCents; // despesas que não variam com o volume de serviços

  // Custo variável da margem de contribuição: o custo estimado dos serviços vendidos acompanha o
  // volume de trabalho (consumo), enquanto as compras lançadas no caixa dependem de quando se
  // compra estoque. Usa o estimado quando existe; senão, os custos variáveis lançados.
  const basis = t.estimatedServiceCostsCents > 0 ? 'ESTIMADO' : 'LANCADO';
  const variable = basis === 'ESTIMADO' ? t.estimatedServiceCostsCents : t.variableCostsCents;
  const be = breakEven({ fixedCents: fixed, revenueCents: t.revenueCents, variableCostsCents: variable });

  const avgTicket = t.revenueCount ? Math.round(t.revenueCents / t.revenueCount) : 0;
  const remaining = be.break_even_cents === null ? null : Math.max(be.break_even_cents - t.revenueCents, 0);

  // Receita acumulada dia a dia, para comparar com a linha do ponto de equilíbrio.
  let cumulative = null;
  if (daysBetween(p.start, p.end) <= MAX_DAILY_BUCKETS) {
    const { results } = await env.DB.prepare(
      `SELECT date, SUM(amount_cents) AS total FROM revenues
        WHERE tenant_id = ? AND status = 'ATIVO' AND date BETWEEN ? AND ? GROUP BY date`,
    ).bind(auth.tenantId, p.start, p.end).all();
    const byDay = Object.fromEntries(results.map((row) => [row.date, row.total]));
    let running = 0;
    cumulative = buckets(p.start, p.end, 'day').map((day) => {
      running += byDay[day] ?? 0;
      return { date: day, revenue_cents: running };
    });
  }

  return ok({
    period: p,
    revenue_cents: t.revenueCents,
    variable_cost_basis: basis,
    variable_costs_cents: variable,
    variable_costs_recorded_cents: t.variableCostsCents,
    fixed_expenses_cents: t.fixedCents,
    other_expenses_cents: t.otherCents,
    ...be,
    progress_bp: be.break_even_cents ? ratioBp(t.revenueCents, be.break_even_cents) : null,
    remaining_cents: remaining,
    avg_ticket_cents: avgTicket,
    services_needed: remaining && avgTicket ? Math.ceil(remaining / avgTicket) : remaining === 0 ? 0 : null,
    cumulative,
  });
}
