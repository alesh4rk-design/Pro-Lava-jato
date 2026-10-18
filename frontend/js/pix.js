// Chave PIX no navegador: mesma validação do servidor (que sempre confere de novo), só para orientar a pessoa.

export const PIX_TYPE_LABELS = { CPF: 'CPF', CNPJ: 'CNPJ', EMAIL: 'E-mail', TELEFONE: 'Telefone', ALEATORIA: 'Aleatória' };

export const PIX_PLACEHOLDERS = {
  CPF: '000.000.000-00',
  CNPJ: '00.000.000/0000-00',
  EMAIL: 'pagamentos@seulavajato.com.br',
  TELEFONE: '(11) 98888-7777',
  ALEATORIA: '123e4567-e89b-12d3-a456-426614174000',
};

const allSame = (digits) => /^(\d)\1+$/.test(digits);

export function isValidCpf(digits) {
  if (!/^\d{11}$/.test(digits) || allSame(digits)) return false;
  for (const length of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += Number(digits[i]) * (length + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(digits[length])) return false;
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

/** Devolve a mensagem de erro para mostrar ao lado do campo, ou null se a chave parece correta. */
export function pixError(type, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'Informe a chave PIX.';
  switch (type) {
    case 'CPF': return isValidCpf(raw.replace(/[.\-\s]/g, '')) ? null : 'CPF incorreto. Confira os números.';
    case 'CNPJ': return isValidCnpj(raw.replace(/[.\-/\s]/g, '')) ? null : 'CNPJ incorreto. Confira os números.';
    case 'EMAIL': return /^[^\s@<>]{1,64}@[^\s@<>]+\.[^\s@<>]{2,}$/.test(raw) && raw.length <= 77 ? null : 'E-mail inválido.';
    case 'TELEFONE': {
      const digits = raw.replace(/[\s()\-+]/g, '');
      const ok = /^\d+$/.test(digits) && (digits.length === 10 || digits.length === 11 || ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')));
      return ok ? null : 'Telefone inválido. Use DDD + número.';
    }
    case 'ALEATORIA': return /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(raw) ? null : 'Chave aleatória inválida. Ela tem 32 letras e números separados por hífens.';
    default: return 'Escolha o tipo da chave.';
  }
}

/** Como mostrar a chave guardada (CPF e CNPJ com pontos, telefone com DDD). */
export function formatPixKey(type, key) {
  if (type === 'CPF' && /^\d{11}$/.test(key)) return key.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (type === 'CNPJ' && /^\d{14}$/.test(key)) return key.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (type === 'TELEFONE' && /^\+55\d{10,11}$/.test(key)) {
    const local = key.slice(3);
    return `(${local.slice(0, 2)}) ${local.slice(2, local.length - 4)}-${local.slice(-4)}`;
  }
  return key;
}
