// Dashboard: indicadores do período escolhido e resumo do mês, calculados com lançamentos ATIVOS.

import { ok } from './lib/http.js';
import { resolvePeriod, today, monthStart, weekStart } from './lib/dates.js';
import { summarize } from './lib/finance.js';
import { timeZone } from './entries.js';

export async function getDashboard({ env, auth, url }) {
  const tz = timeZone(env);
  const period = resolvePeriod(url.searchParams, tz);
  const now = today(tz);
  const month = monthStart(now);
  const week = weekStart(now);
  // Uma leitura por tabela cobre o período escolhido e o resumo do mês/semana/dia.
  const from = [period.start, month, week].sort()[0];
  const to = period.end > now ? period.end : now;

  const [rev, exp] = await env.DB.batch([
    env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN date BETWEEN ?2 AND ?3 THEN amount_cents END), 0) AS period_total,
         COUNT(CASE WHEN date BETWEEN ?2 AND ?3 THEN 1 END)                       AS period_count,
         COUNT(CASE WHEN date BETWEEN ?2 AND ?3 AND service_id IS NOT NULL THEN 1 END) AS period_services,
         COALESCE(SUM(CASE WHEN date = ?4 THEN amount_cents END), 0)              AS today_total,
         COALESCE(SUM(CASE WHEN date BETWEEN ?5 AND ?4 THEN amount_cents END), 0) AS week_total,
         COALESCE(SUM(CASE WHEN date BETWEEN ?6 AND ?4 THEN amount_cents END), 0) AS month_total
       FROM revenues WHERE tenant_id = ?1 AND status = 'ATIVO' AND date BETWEEN ?7 AND ?8`,
    ).bind(auth.tenantId, period.start, period.end, now, week, month, from, to),
    env.DB.prepare(
      `SELECT type,
         COALESCE(SUM(CASE WHEN date BETWEEN ?2 AND ?3 THEN amount_cents END), 0) AS period_total,
         COALESCE(SUM(CASE WHEN date BETWEEN ?4 AND ?5 THEN amount_cents END), 0) AS month_total
       FROM expenses WHERE tenant_id = ?1 AND status = 'ATIVO' AND date BETWEEN ?6 AND ?7
       GROUP BY type`,
    ).bind(auth.tenantId, period.start, period.end, month, now, from, to),
  ]);

  const r = rev.results[0];
  const byType = Object.fromEntries(exp.results.map((row) => [row.type, row]));
  const expense = (type, field) => byType[type]?.[field] ?? 0;

  const totals = summarize({
    revenueCents: r.period_total,
    variableCostsCents: expense('CUSTO_VARIAVEL', 'period_total'),
    fixedCents: expense('DESPESA_FIXA', 'period_total'),
    otherCents: expense('OUTRA', 'period_total'),
    revenueCount: r.period_count,
    servicesCount: r.period_services,
  });
  const monthTotals = summarize({
    revenueCents: r.month_total,
    variableCostsCents: expense('CUSTO_VARIAVEL', 'month_total'),
    fixedCents: expense('DESPESA_FIXA', 'month_total'),
    otherCents: expense('OUTRA', 'month_total'),
    revenueCount: 0,
  });

  return ok({
    period,
    totals,
    snapshot: {
      revenue_today_cents: r.today_total,
      revenue_week_cents: r.week_total,
      revenue_month_cents: r.month_total,
      costs_month_cents: monthTotals.variable_costs_cents,
      expenses_month_cents: monthTotals.expenses_cents,
      result_month_cents: monthTotals.result_cents,
    },
  });
}
