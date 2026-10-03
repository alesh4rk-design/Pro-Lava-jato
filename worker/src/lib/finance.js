// Cálculos financeiros em inteiros. Dinheiro em centavos; percentuais em pontos-base (4350 = 43,50%).

/**
 * Resultado e indicadores a partir dos totais do período.
 *  - Custos: despesas do tipo CUSTO_VARIAVEL (variam com o volume de serviços)
 *  - Despesas: DESPESA_FIXA + OUTRA
 *  - Serviços: receitas ligadas a um serviço; ticket médio: receita ÷ número de receitas
 */
export function summarize({ revenueCents, variableCostsCents, fixedCents, otherCents, revenueCount, servicesCount = revenueCount }) {
  const expensesCents = fixedCents + otherCents;
  const resultCents = revenueCents - variableCostsCents - expensesCents;
  return {
    revenue_cents: revenueCents,
    variable_costs_cents: variableCostsCents,
    expenses_cents: expensesCents,
    result_cents: resultCents,
    margin_bp: ratioBp(resultCents, revenueCents),
    services_count: servicesCount,
    avg_ticket_cents: revenueCount > 0 ? Math.round(revenueCents / revenueCount) : 0,
  };
}

/** numerador/denominador em pontos-base, arredondado; null quando não há denominador. */
export function ratioBp(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator * 10_000) / denominator);
}
