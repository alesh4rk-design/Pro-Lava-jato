// Mensalidade do lava-jato: situação a partir de "pago até" e do tipo de assinatura.
// TESTE: período de teste (até a data). ATIVA: paga. CANCELADA: não renova, vale até a data paga. ISENTA: cortesia, nunca vence.

import { daysBetween } from './dates.js';

export const SUBSCRIPTION_STATUSES = ['TESTE', 'ATIVA', 'CANCELADA', 'ISENTA'];
export const TRIAL_DAYS = 7; // teste grátis ao autorizar um lava-jato novo
export const GRACE_DAYS = 3; // tolerância depois do vencimento, antes de cortar o acesso
export const DUE_SOON_DAYS = 5; // "vencendo": faltam até 5 dias

/**
 * state: ISENTA | TESTE | EM_DIA | VENCENDO | EM_ATRASO | VENCIDA | CANCELADA
 * access: pode usar o sistema? (VENCIDA e CANCELADA depois da data não podem)
 * days_left: dias até o vencimento (negativo = atrasado)
 */
export function billingState({ subscription_status: status, paid_until: paidUntil }, todayIso) {
  if (status === 'ISENTA') return { state: 'ISENTA', access: true, days_left: null, paid_until: paidUntil ?? null };
  if (!paidUntil) return { state: status === 'CANCELADA' ? 'CANCELADA' : 'VENCIDA', access: false, days_left: null, paid_until: null };
  const daysLeft = daysBetween(todayIso, paidUntil);
  const base = { days_left: daysLeft, paid_until: paidUntil };
  if (status === 'CANCELADA') return { ...base, state: 'CANCELADA', access: daysLeft >= 0 };
  if (daysLeft >= 0) {
    if (status === 'TESTE') return { ...base, state: 'TESTE', access: true };
    return { ...base, state: daysLeft <= DUE_SOON_DAYS ? 'VENCENDO' : 'EM_DIA', access: true };
  }
  return { ...base, state: -daysLeft <= GRACE_DAYS ? 'EM_ATRASO' : 'VENCIDA', access: -daysLeft <= GRACE_DAYS };
}
