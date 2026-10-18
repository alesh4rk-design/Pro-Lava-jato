// Textos do seletor de cliente (sem dependência de tela, para usar nos testes).

/** O que foi digitado vira o nome do cliente novo, a menos que pareça telefone ou placa (tem número). */
export const nameFromSearch = (typed) => (/\d/.test(typed) ? '' : typed.trim());
