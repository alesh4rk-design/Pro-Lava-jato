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
 * Converte texto digitado ("1.234,56", "70,5", "40", "10.50") em centavos.
 * Teclados de celular às vezes oferecem ponto como separador decimal: um único ponto seguido
 * de 1 ou 2 dígitos (sem vírgula) é tratado como decimal; seguido de 3 dígitos, como milhar.
 * Retorna null se o valor for inválido, zero, negativo ou acima do teto.
 */
export function parseMoneyToCents(input) {
  if (typeof input !== 'string') return null;
  let text = input.replace(/^\s*R\$\s*/i, '').trim();
  if (/^\d+\.\d{1,2}$/.test(text)) text = text.replace('.', ',');
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(text)) return null;

  const [intPart, decPart = ''] = text.replace(/\./g, '').split(',');
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_CENTS) return null;
  return cents;
}

/** Centavos -> texto para edição em campo ("7050" -> "70,50"). */
export function centsToInput(cents) {
  if (!Number.isSafeInteger(cents) || cents <= 0) return '';
  return `${Math.trunc(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
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

/* Quantidades de produto: guardadas na menor unidade (ml, g, un), exibidas de forma legível. */

export const UNITS = {
  ML: { small: 'ml', big: 'L', factor: 1000, label: 'Líquido (L / ml)' },
  G: { small: 'g', big: 'kg', factor: 1000, label: 'Peso (kg / g)' },
  UN: { small: 'un', big: null, factor: 1, label: 'Unidade' },
};

const qtyFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });

/** 20000 ML -> "20 L"; 500 ML -> "500 ml"; 2500 G -> "2,5 kg"; 12 UN -> "12 un". */
export function formatQty(qty, unit) {
  const info = UNITS[unit];
  if (!info || !Number.isSafeInteger(qty)) return '—';
  if (info.big && Math.abs(qty) >= info.factor) return `${qtyFormatter.format(qty / info.factor)} ${info.big}`;
  return `${qtyFormatter.format(qty)} ${info.small}`;
}

/**
 * Converte o texto digitado para a menor unidade. multiplier = 1000 quando o usuário escolheu L/kg.
 * Aceita vírgula ou ponto e até 3 casas decimais; o resultado precisa ser inteiro e positivo.
 */
export function parseQty(input, multiplier = 1, { allowZero = false } = {}) {
  if (typeof input !== 'string') return null;
  const text = input.trim().replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(text)) return null;
  const [intPart, decPart = ''] = text.split('.');
  const milli = Number(intPart) * 1000 + Number(decPart.padEnd(3, '0'));
  if ((milli * multiplier) % 1000 !== 0) return null; // ex.: 0,5 ml não existe
  const qty = (milli * multiplier) / 1000;
  if (!Number.isSafeInteger(qty) || qty > 1_000_000_000 || qty < (allowZero ? 0 : 1)) return null;
  return qty;
}

/** Custo médio (micro-reais por menor unidade) -> "R$ 17,00/L". */
export function formatUnitCost(micro, unit) {
  const info = UNITS[unit];
  if (!info || !Number.isSafeInteger(micro)) return '—';
  return `${formatCents(Math.round((micro * info.factor) / 10_000))}/${info.big ?? 'un'}`;
}
