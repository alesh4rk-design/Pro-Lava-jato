// Chave PIX: tipos aceitos, validação (dígitos verificadores de CPF/CNPJ) e forma normalizada guardada no banco.

import { errors } from './http.js';
import { email as validateEmail } from './validate.js';

export const PIX_TYPES = ['CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'ALEATORIA'];

const allSame = (digits) => /^(\d)\1+$/.test(digits);

export function isValidCpf(digits) {
  if (!/^\d{11}$/.test(digits) || allSame(digits)) return false;
  for (const length of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += Number(digits[i]) * (length + 1 - i);
    const check = ((sum * 10) % 11) % 10;
    if (check !== Number(digits[length])) return false;
  }
  return true;
}

export function isValidCnpj(digits) {
  if (!/^\d{14}$/.test(digits) || allSame(digits)) return false;
  for (const length of [12, 13]) {
    const weights = length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += Number(digits[i]) * weights[i];
    const rest = sum % 11;
    if ((rest < 2 ? 0 : 11 - rest) !== Number(digits[length])) return false;
  }
  return true;
}

const invalid = (what) => errors.validation(`Chave PIX inválida: ${what}.`);

/** Valida e normaliza: CPF/CNPJ só dígitos, telefone +55..., e-mail minúsculo, aleatória minúscula. */
export function normalizePixKey(type, value) {
  if (typeof value !== 'string') throw invalid('informe a chave');
  const raw = value.trim();
  switch (type) {
    case 'CPF': {
      const digits = raw.replace(/[.\-\s]/g, '');
      if (!isValidCpf(digits)) throw invalid('CPF incorreto');
      return digits;
    }
    case 'CNPJ': {
      const digits = raw.replace(/[.\-/\s]/g, '');
      if (!isValidCnpj(digits)) throw invalid('CNPJ incorreto');
      return digits;
    }
    case 'EMAIL': {
      const mail = validateEmail(raw);
      if (mail.length > 77) throw invalid('e-mail muito longo');
      return mail;
    }
    case 'TELEFONE': {
      const digits = raw.replace(/[\s()\-+]/g, '');
      if (!/^\d+$/.test(digits)) throw invalid('telefone incorreto');
      if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
      if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return `+${digits}`;
      throw invalid('use DDD + número');
    }
    case 'ALEATORIA': {
      const key = raw.toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key)) throw invalid('a chave aleatória tem 32 letras e números, como 123e4567-e89b-12d3-a456-426614174000');
      return key;
    }
    default:
      throw errors.validation('Escolha o tipo da chave PIX.');
  }
}

/** Para a auditoria: nunca guarda a chave inteira (é dado pessoal), só o final. */
export const maskPixKey = (key) => (key ? `••••${key.slice(-4)}` : '(sem chave)');
