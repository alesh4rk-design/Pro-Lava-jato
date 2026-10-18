// WhatsApp sem servidor: monta o link wa.me com a mensagem pronta. O app nunca envia nada sozinho:
// o WhatsApp abre com o texto preenchido e a pessoa toca em enviar.

/** Telefone só com dígitos e código do Brasil (55) quando faltar. Retorna '' se não parecer um telefone. */
export function whatsappNumber(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return digits;
  return '';
}

/** "Gol branco · ABC1D23", só o modelo, só a placa ou vazio. */
export function vehicleText({ vehicle = '', plate = '' } = {}) {
  return [vehicle.trim(), plate.trim()].filter(Boolean).join(' · ');
}

export const PIX_MISSING = '[cadastre a chave PIX em Configurações]';

/** {pix}: a chave e, se houver, o nome do recebedor. Sem chave cadastrada, um aviso visível no texto (que é editável). */
export function pixText({ key = '', holder = '' } = {}) {
  if (!key) return PIX_MISSING;
  return holder.trim() ? `${key}\nRecebedor: ${holder.trim()}` : key;
}

/**
 * Troca {nome}, {veiculo}, {placa}, {lavajato} e {pix} pelos dados. Campo vazio some sem deixar espaços sobrando.
 * O veículo entra entre parênteses quando existir: "do seu veículo (Gol · ABC1D23)".
 */
export function renderMessage(body, customer, businessName = '', pix = {}) {
  const vehicle = vehicleText(customer);
  const values = {
    nome: (customer.name ?? '').trim(),
    veiculo: vehicle ? `(${vehicle})` : '',
    placa: (customer.plate ?? '').trim(),
    lavajato: businessName.trim(),
    pix: pixText(pix),
  };
  return body
    .replace(/\{(nome|veiculo|placa|lavajato|pix)\}/g, (_, key) => values[key])
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([,.!?;:])/g, '$1')
    .replace(/— *$/gm, '')
    .replace(/ *\n */g, '\n')
    .trim();
}

/** Link para abrir o WhatsApp no número do cliente com a mensagem pronta; '' se o telefone for inválido. */
export function whatsappUrl(phone, message) {
  const number = whatsappNumber(phone);
  if (!number) return '';
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}
