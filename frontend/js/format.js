// Formatação e conversão de valores. Dinheiro sempre trafega como inteiro em centavos.

export const MAX_CENTS = 10_000_000_000; // R$ 100 milhões: teto de sanidade para um lançamento.

const groupFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

/** 1845000 -> "R$ 18.450,00" (espaço inseparável). Usa aritmética inteira, sem ponto flutuante. */
export function formatCents(cents) {
  if (!Number.isSafeInteger(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const reais = groupFormatter.format(Math.trunc(abs / 100));
  const centavos = String(abs % 100).padStart(2, '0');
  return `${sign}R$\u00a0${reais},${centavos}`;
}

/**
 * Converte texto digitado ("1.234,56", "70,5", "40") em centavos.
 * Retorna null se o valor for inválido, zero, negativo ou acima do teto.
 */
export function parseMoneyToCents(input) {
  if (typeof input !== 'string') return null;
  const text = input.replace(/^\s*R\$\s*/i, '').trim();
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(text)) return null;

  const [intPart, decPart = ''] = text.replace(/\./g, '').split(',');
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_CENTS) return null;
  return cents;
}

/** Margem em pontos-base (4350 = 43,50%) -> "43,5%". */
export function formatBasisPoints(bp) {
  if (!Number.isSafeInteger(bp)) return '—';
  const pct = (bp / 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${pct}%`;
}

export function formatInteger(n) {
  return Number.isSafeInteger(n) ? groupFormatter.format(n) : '—';
}

/** Valida data no formato YYYY-MM-DD e se ela existe no calendário. */
export function isValidISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** "2026-10-03" -> "03/10/2026" */
export function formatDate(iso) {
  if (!isValidISODate(iso)) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Carimbo ISO UTC ("2026-10-03T14:05:00.000Z") -> "03/10/2026 11:05" no fuso informado. */
export function formatDateTime(timestamp, timeZone, { time = true } = {}) {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : null;
  if (!date || Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone, day: '2-digit', month: '2-digit', year: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date).replace(',', '');
}

/** "11988887777" -> "(11) 98888-7777" */
export function formatPhone(digits) {
  if (typeof digits !== 'string' || !/^\d{10,13}$/.test(digits)) return digits || '';
  const local = digits.length > 11 ? digits.slice(-11) : digits;
  const ddd = local.slice(0, 2);
  const rest = local.slice(2);
  return `(${ddd}) ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
}

/** Data de hoje (YYYY-MM-DD) no fuso informado, independente do fuso do aparelho. */
export function todayISO(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254
    && /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(value);
}

/** Mesma regra do servidor: 8 a 128 caracteres, com letras e números. */
export function isStrongPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128 && /[A-Za-z]/.test(value) && /\d/.test(value);
}
