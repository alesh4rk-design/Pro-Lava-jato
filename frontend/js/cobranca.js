// Textos e contas da mensalidade (sem dependência de tela, para o painel financeiro e os testes).

import { formatCents, formatDate } from './format.js';

export const PAYMENT_METHODS = { PIX: 'PIX', DINHEIRO: 'Dinheiro', TRANSFERENCIA: 'Transferência', CARTAO: 'Cartão', OUTRO: 'Outro' };

/** Soma meses a uma data AAAA-MM-DD; o dia vira o último do mês quando não existe (mesma regra do servidor). */
export function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = index % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** Vencimento que um pagamento vai gerar: a partir do vencimento atual (se ainda vale) ou de hoje. */
export function nextPaidUntil({ paidUntil, today, months }) {
  const base = paidUntil && paidUntil >= today ? paidUntil : today;
  return addMonths(base, months);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Selo de cada situação: { label, tone } (tone = classe do selo). */
export function stateBadge(billing) {
  const { state, days_left: left, paid_until: until } = billing;
  switch (state) {
    case 'EM_DIA': return { label: 'Em dia', tone: 'badge-success' };
    case 'VENCENDO': return { label: left === 0 ? 'Vence hoje' : `Vence em ${plural(left, 'dia', 'dias')}`, tone: 'badge-warning' };
    case 'EM_ATRASO': return { label: `Atrasada há ${plural(-left, 'dia', 'dias')}`, tone: 'badge-danger' };
    case 'VENCIDA': return { label: 'Vencida · sem acesso', tone: 'badge-danger' };
    case 'TESTE': return { label: until ? `Teste até ${formatDate(until).slice(0, 5)}` : 'Em teste', tone: 'badge-primary' };
    case 'CANCELADA': return billing.access
      ? { label: `Cancelada · acesso até ${formatDate(until).slice(0, 5)}`, tone: 'badge-warning' }
      : { label: 'Cancelada · sem acesso', tone: 'badge-danger' };
    case 'ISENTA': return { label: 'Isenta', tone: 'badge' };
    default: return { label: state, tone: 'badge' };
  }
}

/** "Pago até 18/11/2026 · faltam 5 dias" / "venceu há 3 dias" / "" */
export function dueLine(billing) {
  if (!billing.paid_until || billing.state === 'ISENTA') return '';
  const left = billing.days_left;
  const tail = left > 0 ? `faltam ${plural(left, 'dia', 'dias')}` : left === 0 ? 'vence hoje' : `venceu há ${plural(-left, 'dia', 'dias')}`;
  return `${billing.state === 'TESTE' ? 'Teste até' : 'Pago até'} ${formatDate(billing.paid_until)} · ${tail}`;
}

/** Mensagem de cobrança para abrir no WhatsApp (o administrador revisa antes de enviar). */
export function collectionMessage({ owner, business, billing, priceCents }) {
  const first = (owner || '').trim().split(/\s+/)[0] || 'tudo bem';
  const when = billing.days_left < 0 ? `venceu em ${formatDate(billing.paid_until)}` : billing.days_left === 0 ? 'vence hoje' : `vence em ${formatDate(billing.paid_until)}`;
  const value = priceCents > 0 ? ` Valor: ${formatCents(priceCents)}.` : '';
  return `Olá, ${first}! Passando para lembrar que a mensalidade do sistema do ${business} ${when}.${value} Qualquer dúvida é só responder por aqui. Obrigado!`;
}

/** Aviso para o administrador do lava-jato no Início. Retorna null quando não há nada a avisar. */
export function subscriptionNotice(subscription) {
  if (!subscription) return null;
  const { state, days_left: left, paid_until: until } = subscription;
  const date = until ? formatDate(until) : '';
  if (state === 'VENCENDO') return { urgent: left <= 1, text: left === 0 ? 'Sua mensalidade vence hoje.' : `Sua mensalidade vence em ${plural(left, 'dia', 'dias')} (${date}).` };
  if (state === 'EM_ATRASO') return { urgent: true, text: `Sua mensalidade venceu em ${date}. Regularize para não perder o acesso.` };
  if (state === 'TESTE' && left <= 3) return { urgent: left <= 1, text: left === 0 ? 'Seu período de teste termina hoje.' : `Seu período de teste termina em ${plural(left, 'dia', 'dias')} (${date}).` };
  if (state === 'CANCELADA') return { urgent: true, text: `Assinatura cancelada. Você pode usar o sistema até ${date}.` };
  return null;
}
