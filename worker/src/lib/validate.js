// Validação de entrada. Todo dado vindo do navegador é tratado como não confiável.
// Cada validador recebe o valor bruto e devolve o valor normalizado ou lança VALIDATION_ERROR.

import { errors } from './http.js';

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function text(value, { field, min = 0, max, multiline = false }) {
  if (typeof value !== 'string') throw errors.validation(`Campo "${field}" inválido.`);
  let clean = value.replace(CONTROL_CHARS, '').normalize('NFC');
  clean = multiline ? clean.trim() : clean.replace(/\s+/g, ' ').trim();
  if (clean.length < min || clean.length > max) {
    throw errors.validation(min > 0 && clean.length < min ? `Informe ${field}.` : `Campo "${field}" muito longo.`);
  }
  return clean;
}

export function optionalText(value, opts) {
  return value === undefined || value === null ? '' : text(value, opts);
}

const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export function email(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized.length > 254 || !EMAIL_RE.test(normalized)) throw errors.validation('Informe um e-mail válido.');
  return normalized;
}

/** Senha nova: 8 a 128 caracteres, com letras e números. Nunca é normalizada ou registrada. */
export function newPassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    throw errors.validation('A senha deve ter de 8 a 128 caracteres, com letras e números.');
  }
  return value;
}

/** Senha informada no login: só checa tipo e tamanho para limitar custo de processamento. */
export function passwordInput(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) throw errors.invalidCredentials();
  return value;
}

export function phone(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw errors.validation('Telefone inválido.');
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) throw errors.validation('Telefone inválido. Use DDD + número.');
  return digits;
}

export function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw errors.validation(`Campo "${field}" inválido.`);
  return value;
}

export function bool(value, field) {
  if (typeof value !== 'boolean') throw errors.validation(`Campo "${field}" inválido.`);
  return value;
}

/** ID vindo da URL: inteiro positivo em formato estrito (rejeita "1e3", "01", "1;DROP"). */
export function id(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) throw errors.notFound();
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw errors.notFound();
  return n;
}

/** Garante que o corpo só tem campos conhecidos (evita mass assignment silencioso). */
export function onlyFields(body, allowed) {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw errors.validation('A requisição contém campos não permitidos.');
  return body;
}

export const MAX_CENTS = 10_000_000_000; // R$ 100 milhões por lançamento

/** Valor monetário em centavos: inteiro positivo dentro do teto. Rejeita 70.5, "7050", NaN. */
export function cents(value, field = 'valor') {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CENTS) throw errors.validation(`Campo "${field}" inválido.`);
  return value;
}

/** ID vindo no corpo JSON (número inteiro positivo). */
export function bodyId(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw errors.validation(`Campo "${field}" inválido.`);
  return value;
}

export function optionalBodyId(value, field) {
  return value === undefined || value === null ? null : bodyId(value, field);
}

/** Número da página em query string (1..10000). */
export function page(searchParams) {
  const raw = searchParams.get('page') ?? '1';
  if (!/^[1-9]\d{0,3}$/.test(raw)) throw errors.validation('Página inválida.');
  return Number(raw);
}

/** Texto de busca para LIKE, com curingas escapados (usar com ESCAPE '\\'). */
export function likePattern(value) {
  if (value === null || value === undefined || value.trim() === '') return null;
  const clean = text(value, { field: 'busca', max: 60 });
  return `%${clean.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
