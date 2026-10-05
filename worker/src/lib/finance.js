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

/**
 * Ponto de equilíbrio = despesas fixas ÷ margem de contribuição,
 * onde margem de contribuição = (faturamento − custos variáveis) ÷ faturamento.
 * Calculado como fixas × faturamento ÷ contribuição, em BigInt para não perder precisão.
 * Sem faturamento ou com contribuição ≤ 0 o ponto não existe: retorna null e o motivo.
 */
export function breakEven({ fixedCents, revenueCents, variableCostsCents }) {
  const contribution = revenueCents - variableCostsCents;
  const base = { contribution_cents: contribution, contribution_margin_bp: ratioBp(contribution, revenueCents) };
  if (revenueCents <= 0) return { ...base, break_even_cents: null, reason: 'SEM_FATURAMENTO' };
  if (contribution <= 0) return { ...base, break_even_cents: null, reason: 'MARGEM_NAO_POSITIVA' };
  if (fixedCents <= 0) return { ...base, break_even_cents: 0, reason: null };

  const f = BigInt(fixedCents);
  const r = BigInt(revenueCents);
  const c = BigInt(contribution);
  const rounded = (2n * f * r + c) / (2n * c); // arredonda meio para cima
  return { ...base, break_even_cents: Number(rounded), reason: null };
}
