import { describe, it, expect } from 'vitest';
import { call, financeFixture, seedService, seedCategory, todayIso } from './helpers.js';
import { breakEven } from '../src/lib/finance.js';
import { addDays } from '../src/lib/dates.js';

async function post(f, path, body) {
  const res = await call('POST', path, { token: f.adminToken, body: { date: todayIso(), payment_method: 'PIX', ...body } });
  if (res.status !== 201) throw new Error(JSON.stringify(res.json));
  return res.json.data;
}
const get = (f, path, token = f.adminToken) => call('GET', path, { token });

describe('ponto de equilíbrio (cálculo)', () => {
  it('exemplo do enunciado: fixas R$ 9.000 e margem de contribuição 60% → R$ 15.000', () => {
    const r = breakEven({ fixedCents: 900_000, revenueCents: 2_000_000, variableCostsCents: 800_000 });
    expect(r).toMatchObject({ contribution_margin_bp: 6000, break_even_cents: 1_500_000, reason: null });
  });

  it('sem faturamento ou com margem de contribuição não positiva não há ponto de equilíbrio', () => {
    expect(breakEven({ fixedCents: 100, revenueCents: 0, variableCostsCents: 0 })).toMatchObject({ break_even_cents: null, reason: 'SEM_FATURAMENTO' });
    expect(breakEven({ fixedCents: 100, revenueCents: 1000, variableCostsCents: 1000 })).toMatchObject({ break_even_cents: null, reason: 'MARGEM_NAO_POSITIVA' });
    expect(breakEven({ fixedCents: 100, revenueCents: 1000, variableCostsCents: 1500 })).toMatchObject({ break_even_cents: null, reason: 'MARGEM_NAO_POSITIVA' });
  });

  it('sem despesas fixas o ponto é zero', () => {
    expect(breakEven({ fixedCents: 0, revenueCents: 1000, variableCostsCents: 200 }).break_even_cents).toBe(0);
  });

  it('valores enormes não perdem precisão', () => {
    // 1e10 × 9e11 passa de 2^53: o cálculo usa BigInt
    const r = breakEven({ fixedCents: 10_000_000_000, revenueCents: 900_000_000_000, variableCostsCents: 300_000_000_000 });
    expect(r.break_even_cents).toBe(15_000_000_000);
    const odd = breakEven({ fixedCents: 1, revenueCents: 3, variableCostsCents: 1 }); // 1 × 3 / 2 = 1,5 → 2
    expect(odd.break_even_cents).toBe(2);
  });
});

describe('relatórios', () => {
  it('somente ADMIN acessa (verificado no servidor)', async () => {
    const f = await financeFixture();
    for (const path of ['/api/reports/financial', '/api/reports/categories', '/api/reports/services', '/api/reports/break-even']) {
      expect((await get(f, path, f.opToken)).status, path).toBe(403);
      expect((await call('GET', path)).status, path).toBe(401);
      expect((await get(f, path)).status, path).toBe(200);
    }
  });

  it('financeiro: totais, série diária e formas de pagamento', async () => {
    const f = await financeFixture();
    const yesterday = addDays(todayIso(), -1);
    await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 7000 });
    await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 3000, payment_method: 'DINHEIRO', date: yesterday });
    await post(f, '/api/expenses', { category_id: f.variableCategoryId, amount_cents: 1000 });
    await post(f, '/api/expenses', { category_id: f.categoryId, amount_cents: 4000, date: yesterday });

    const res = await get(f, `/api/reports/financial?period=custom&start=${yesterday}&end=${todayIso()}`);
    const d = res.json.data;
    expect(d.granularity).toBe('day');
    expect(d.totals).toMatchObject({ revenue_cents: 10000, variable_costs_cents: 1000, expenses_cents: 4000, result_cents: 5000, margin_bp: 5000 });
    expect(d.series).toEqual([
      { bucket: yesterday, revenue_cents: 3000, variable_costs_cents: 0, expenses_cents: 4000, result_cents: -1000 },
      { bucket: todayIso(), revenue_cents: 7000, variable_costs_cents: 1000, expenses_cents: 0, result_cents: 6000 },
    ]);
    expect(d.payment_methods.find((m) => m.method === 'PIX')).toMatchObject({ total_cents: 7000, count: 1, share_bp: 7000 });
    expect(d.payment_methods.find((m) => m.method === 'DINHEIRO')).toMatchObject({ total_cents: 3000, share_bp: 3000 });
    expect(d.payment_methods.find((m) => m.method === 'CREDITO')).toMatchObject({ total_cents: 0, share_bp: 0 });
  });

  it('financeiro: períodos longos viram série mensal com todos os meses', async () => {
    const f = await financeFixture();
    const res = await get(f, '/api/reports/financial?period=custom&start=2025-11-15&end=2026-02-10');
    expect(res.json.data.granularity).toBe('month');
    expect(res.json.data.series.map((p) => p.bucket)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('por categoria: ordena pelo maior gasto e calcula a participação', async () => {
    const f = await financeFixture();
    const marketing = await seedCategory(f.tenantId, { name: 'Marketing', type: 'OUTRA' });
    await post(f, '/api/expenses', { category_id: f.categoryId, amount_cents: 6000 });
    await post(f, '/api/expenses', { category_id: marketing, amount_cents: 1000 });
    await post(f, '/api/expenses', { category_id: f.variableCategoryId, amount_cents: 3000 });
    const cancelled = await post(f, '/api/expenses', { category_id: marketing, amount_cents: 99999 });
    await call('DELETE', `/api/expenses/${cancelled.id}`, { token: f.adminToken });

    const d = (await get(f, '/api/reports/categories?period=today')).json.data;
    expect(d.total_cents).toBe(10000);
    expect(d.items.map((i) => [i.total_cents, i.share_bp])).toEqual([[6000, 6000], [3000, 3000], [1000, 1000]]);
    expect(d.items[1]).toMatchObject({ variable_costs_cents: 3000, fixed_cents: 0 });
  });

  it('por serviço: quantidade, receita, custo e margem estimados; receitas avulsas separadas', async () => {
    const f = await financeFixture();
    const simples = await seedService(f.tenantId, { name: 'Lavagem simples', priceCents: 4000 });
    await call('PUT', `/api/services/${f.serviceId}/costs`, { token: f.adminToken, body: { items: [{ description: 'Água', fixed_cost_cents: 500 }] } });
    await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 7000 });
    await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 7000 });
    await post(f, '/api/revenues', { service_id: simples, amount_cents: 4000 });
    await post(f, '/api/revenues', { description: 'Gorjeta', amount_cents: 500 });

    const d = (await get(f, '/api/reports/services?period=today')).json.data;
    expect(d.total_revenue_cents).toBe(18500);
    expect(d.items[0]).toMatchObject({ service_id: f.serviceId, count: 2, revenue_cents: 14000, estimated_cost_cents: 1000, estimated_margin_cents: 13000, estimated_margin_bp: 9286, avg_price_cents: 7000 });
    expect(d.items[1]).toMatchObject({ name: 'Lavagem simples', estimated_cost_cents: 0 });
    expect(d.items[2]).toMatchObject({ service_id: null, name: 'Outras receitas', estimated_cost_cents: null, estimated_margin_bp: null });
  });

  it('ponto de equilíbrio com dados reais: falta faturar e serviços necessários', async () => {
    const f = await financeFixture();
    await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 10000 });
    await post(f, '/api/expenses', { category_id: f.variableCategoryId, amount_cents: 4000 }); // MC = 60%
    await post(f, '/api/expenses', { category_id: f.categoryId, amount_cents: 9000 }); // fixas

    const d = (await get(f, '/api/reports/break-even?period=today')).json.data;
    expect(d).toMatchObject({
      revenue_cents: 10000,
      variable_cost_basis: 'LANCADO',
      fixed_expenses_cents: 9000,
      contribution_margin_bp: 6000,
      break_even_cents: 15000,
      remaining_cents: 5000,
      progress_bp: 6667,
      avg_ticket_cents: 10000,
      services_needed: 1,
    });
    expect(d.cumulative).toEqual([{ date: todayIso(), revenue_cents: 10000 }]);
  });

  it('ponto de equilíbrio usa o custo estimado dos serviços vendidos quando existe', async () => {
    const f = await financeFixture();
    // custo estimado do serviço: R$ 28,00 em R$ 70,00 → margem de contribuição 60%
    await call('PUT', `/api/services/${f.serviceId}/costs`, { token: f.adminToken, body: { items: [{ description: 'Insumos', fixed_cost_cents: 2800 }] } });
    await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 7000 });
    // compra grande de estoque no mesmo período: não deve distorcer a margem de contribuição
    await post(f, '/api/expenses', { category_id: f.variableCategoryId, amount_cents: 50000 });
    await post(f, '/api/expenses', { category_id: f.categoryId, amount_cents: 9000 });

    const d = (await get(f, '/api/reports/break-even?period=today')).json.data;
    expect(d).toMatchObject({
      variable_cost_basis: 'ESTIMADO',
      variable_costs_cents: 2800,
      variable_costs_recorded_cents: 50000,
      contribution_margin_bp: 6000,
      break_even_cents: 15000,
    });
  });

  it('ponto de equilíbrio sem faturamento informa o motivo', async () => {
    const f = await financeFixture();
    await post(f, '/api/expenses', { category_id: f.categoryId, amount_cents: 9000 });
    const d = (await get(f, '/api/reports/break-even?period=today')).json.data;
    expect(d).toMatchObject({ break_even_cents: null, reason: 'SEM_FATURAMENTO', remaining_cents: null, services_needed: null });
  });

  it('não mistura dados de outro lava-jato e valida o período', async () => {
    const a = await financeFixture();
    const b = await financeFixture();
    await post(b, '/api/revenues', { service_id: b.serviceId, amount_cents: 55555 });
    expect((await get(a, '/api/reports/financial?period=today')).json.data.totals.revenue_cents).toBe(0);
    expect((await get(a, '/api/reports/services?period=today')).json.data.items).toEqual([]);
    expect((await get(a, '/api/reports/categories?period=custom&start=2026-05-10&end=2026-05-01')).status).toBe(400);
    expect((await get(a, "/api/reports/financial?period=custom&start=2026-01-01'--&end=2026-01-31")).status).toBe(400);
  });
});
