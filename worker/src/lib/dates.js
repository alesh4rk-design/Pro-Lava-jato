// Datas de negócio (YYYY-MM-DD) no fuso do lava-jato e resolução de períodos.

import { errors } from './http.js';

const DAY_MS = 86_400_000;
export const MIN_DATE = '2000-01-01';

export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Hoje no fuso informado, independente do fuso do servidor. */
export function today(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export const monthStart = (iso) => `${iso.slice(0, 8)}01`;

/** Segunda-feira da semana da data. */
export function weekStart(iso) {
  const weekday = (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(iso, -weekday);
}

/** Data de lançamento: válida, não anterior a 2000 e não futura. */
export function entryDate(value, timeZone) {
  if (!isValidDate(value)) throw errors.validation('Data inválida.');
  if (value < MIN_DATE) throw errors.validation('Data muito antiga.');
  if (value > today(timeZone)) throw errors.validation('A data não pode ser futura.');
  return value;
}

export const PERIOD_KEYS = ['today', '7d', 'month', 'last_month', 'year', 'custom'];

/**
 * Resolve o período pedido pelo cliente: ?period=<chave> ou ?period=custom&start=&end=.
 * Sem parâmetro, usa o mês atual.
 */
export function resolvePeriod(searchParams, timeZone) {
  const now = today(timeZone);
  const key = searchParams.get('period') ?? (searchParams.has('start') ? 'custom' : 'month');
  switch (key) {
    case 'today': return { key, start: now, end: now };
    case '7d': return { key, start: addDays(now, -6), end: now };
    case 'month': return { key, start: monthStart(now), end: now };
    case 'last_month': {
      const end = addDays(monthStart(now), -1);
      return { key, start: monthStart(end), end };
    }
    case 'year': return { key, start: `${now.slice(0, 4)}-01-01`, end: now };
    case 'custom': {
      const start = searchParams.get('start');
      const end = searchParams.get('end');
      if (!isValidDate(start) || !isValidDate(end) || start > end || start < MIN_DATE) {
        throw errors.validation('Período inválido.');
      }
      return { key, start, end };
    }
    default: throw errors.validation('Período inválido.');
  }
}
