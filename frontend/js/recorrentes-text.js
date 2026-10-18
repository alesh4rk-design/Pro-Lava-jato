// Textos das despesas recorrentes (sem dependência de tela, para usar no Início e nos testes).

export const FREQUENCY_LABELS = { DIARIA: 'Diária', SEMANAL: 'Semanal', MENSAL: 'Mensal' };
export const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

/** "Todo dia", "Toda segunda", "Todo dia 5" (31 = último dia do mês). */
export function scheduleText(r) {
  if (r.frequency === 'DIARIA') return 'Todo dia';
  if (r.frequency === 'SEMANAL') return `Toda ${WEEKDAYS[r.weekday].toLowerCase()}`;
  return r.month_day === 31 ? 'Todo último dia do mês' : `Todo dia ${r.month_day}`;
}

/** "hoje", "amanhã", "em 3 dias" a partir de days_left. */
export function whenText(daysLeft) {
  if (daysLeft <= 0) return 'hoje';
  if (daysLeft === 1) return 'amanhã';
  return `em ${daysLeft} dias`;
}
