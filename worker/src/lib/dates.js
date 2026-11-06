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

/** Diferença (ms) entre o horário local do fuso e UTC no instante informado. */
function tzOffsetMs(timeZone, instantMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Intervalo UTC [início, fim) que cobre os dias locais de start a end (inclusive).
 * Usado para filtrar carimbos de tempo (created_at, em UTC) por datas do lava-jato.
 */
export function localDaysToUtcRange(start, end, timeZone) {
  const startGuess = Date.parse(`${start}T00:00:00Z`);
  const endGuess = Date.parse(`${addDays(end, 1)}T00:00:00Z`);
  return {
    from: new Date(startGuess - tzOffsetMs(timeZone, startGuess)).toISOString(),
    to: new Date(endGuess - tzOffsetMs(timeZone, endGuess)).toISOString(),
  };
}

/** Soma meses a uma data (YYYY-MM-DD); o dia vira o último do mês quando não existe (31/01 + 1 mês = 28/02). */
export function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = index % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** Dias de `from` até `to` (negativo se `to` for antes). */
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
