// Textos do seletor de cliente (sem dependência de tela, para usar nos testes).

/** O que foi digitado vira o nome do cliente novo, a menos que pareça telefone ou placa (tem número). */
export const nameFromSearch = (typed) => (/\d/.test(typed) ? '' : typed.trim());

/** Placa sem espaço nem hífen e em maiúsculas (ABC-1D23 → ABC1D23), como o servidor guarda. */
export const normalizePlate = (value) => String(value ?? '').toUpperCase().replace(/[\s-]/g, '');

/** Mensagem de erro para a placa digitada, ou null se estiver vazia (é opcional) ou parecer correta. */
export const plateError = (value) => {
  const plate = normalizePlate(value);
  return !plate || /^[A-Z0-9]{5,8}$/.test(plate) ? null : 'Placa inválida. Ex.: ABC1D23';
};

/** Na busca, "abc-1234" ou "ABC 1D23" vira a placa guardada; qualquer outro texto fica como foi digitado. */
export const searchTerm = (typed) => {
  const text = typed.trim();
  return /^[A-Za-z]{3}[-\s]?\d[A-Za-z0-9]\d{2}$/.test(text) ? normalizePlate(text) : text;
};
