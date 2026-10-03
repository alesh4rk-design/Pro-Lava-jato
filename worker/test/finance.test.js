import { describe, it, expect } from 'vitest';
import { summarize, ratioBp } from '../src/lib/finance.js';
import { resolvePeriod, addDays, weekStart, today, isValidDate } from '../src/lib/dates.js';

describe('cálculos financeiros', () => {
  it('resultado, margem e ticket médio (exemplo do enunciado)', () => {
    const s = summarize({ revenueCents: 1_845_000, variableCostsCents: 728_000, fixedCents: 300_000, otherCents: 15_000, revenueCount: 312 });
    expect(s.expenses_cents).toBe(315_000);
    expect(s.result_cents).toBe(802_000);
    expect(s.margin_bp).toBe(4347); // 43,47%
    expect(s.avg_ticket_cents).toBe(5913);
  });

  it('prejuízo gera margem negativa', () => {
    const s = summarize({ revenueCents: 100_00, variableCostsCents: 50_00, fixedCents: 100_00, otherCents: 0, revenueCount: 2 });
    expect(s.result_cents).toBe(-50_00);
    expect(s.margin_bp).toBe(-5000);
  });

  it('sem receita: margem indefinida e ticket zero, sem divisão por zero', () => {
    const s = summarize({ revenueCents: 0, variableCostsCents: 0, fixedCents: 9000_00, otherCents: 0, revenueCount: 0 });
    expect(s.result_cents).toBe(-9000_00);
    expect(s.margin_bp).toBeNull();
    expect(s.avg_ticket_cents).toBe(0);
  });

  it('valores muito grandes continuam exatos', () => {
    const s = summarize({ revenueCents: 9_000_000_000_00, variableCostsCents: 1, fixedCents: 0, otherCents: 0, revenueCount: 1 });
    expect(s.result_cents).toBe(899_999_999_999);
    expect(ratioBp(1, 3)).toBe(3333);
  });
});

describe('datas e períodos', () => {
  const params = (obj) => new URLSearchParams(obj);
  const tz = 'America/Sao_Paulo';

  it('valida datas reais', () => {
    expect(isValidDate('2024-02-29')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate("2026-01-01' OR 1=1")).toBe(false);
  });

  it('resolve períodos a partir de hoje', () => {
    const now = today(tz);
    expect(resolvePeriod(params({ period: 'today' }), tz)).toEqual({ key: 'today', start: now, end: now });
    expect(resolvePeriod(params({ period: '7d' }), tz).start).toBe(addDays(now, -6));
    expect(resolvePeriod(params({}), tz).start).toBe(`${now.slice(0, 8)}01`);
    const last = resolvePeriod(params({ period: 'last_month' }), tz);
    expect(last.end).toBe(addDays(`${now.slice(0, 8)}01`, -1));
    expect(last.start.endsWith('-01')).toBe(true);
  });

  it('recusa período personalizado inválido', () => {
    expect(() => resolvePeriod(params({ period: 'custom', start: '2026-05-10', end: '2026-05-01' }), tz)).toThrow();
    expect(() => resolvePeriod(params({ period: 'custom', start: '2026-02-30', end: '2026-03-01' }), tz)).toThrow();
    expect(() => resolvePeriod(params({ period: 'ontem' }), tz)).toThrow();
  });

  it('semana começa na segunda-feira', () => {
    expect(weekStart('2026-10-03')).toBe('2026-09-28'); // sábado -> segunda anterior
    expect(weekStart('2026-09-28')).toBe('2026-09-28');
    expect(weekStart('2026-10-04')).toBe('2026-09-28'); // domingo
  });
});
