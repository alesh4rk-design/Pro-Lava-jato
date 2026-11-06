// Textos e funções puras da agenda e do agendamento online.

export const STATUS_LABELS = { PENDENTE: 'Aguardando confirmação', CONFIRMADO: 'Confirmado', CONCLUIDO: 'Concluído', CANCELADO: 'Cancelado', FALTOU: 'Não compareceu' };
export const WEEKDAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

/** Link público do lava-jato: mesma pasta desta página + agendar.html?c=CÓDIGO. */
export function bookingLink(code, pageUrl) {
  const base = String(pageUrl).split(/[?#]/)[0].replace(/[^/]*$/, '');
  return `${base}agendar.html?c=${encodeURIComponent(code)}`;
}

/** "Sexta, 07/11" para uma data ISO. */
export function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAY_NAMES[weekday]}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

export function addDaysISO(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Mensagem de confirmação para o cliente (WhatsApp). */
export function confirmationMessage({ name, service, date, time, businessName }) {
  return `Olá, ${name}! Seu horário no ${businessName} está confirmado: ${service}, ${dayLabel(date)} às ${time}. Até lá!`;
}

/** Mensagem que o dono envia com o link. */
export function inviteMessage({ businessName, link }) {
  return `Olá! Agora você pode agendar a limpeza do seu veículo no ${businessName} pelo link, escolhendo o dia e o horário: ${link}`;
}
