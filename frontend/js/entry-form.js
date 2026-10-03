// Partes comuns dos formulários de receita e despesa: valor, forma de pagamento, data,
// descrição e observação, com validação e montagem do corpo da requisição.

import { config } from './config.js';
import { parseMoneyToCents, centsToInput, isValidISODate, todayISO } from './format.js';
import { el, field, chipGroup, setFieldError } from './ui.js';

export const PAYMENT_LABELS = { PIX: 'PIX', DINHEIRO: 'Dinheiro', DEBITO: 'Débito', CREDITO: 'Crédito', OUTRO: 'Outro' };
export const EXPENSE_TYPE_LABELS = { CUSTO_VARIAVEL: 'Custo variável', DESPESA_FIXA: 'Despesa fixa', OUTRA: 'Outra' };

const lastPaymentKey = (kind) => `lj.lastPayment.${kind}`;

function rememberedPayment(kind) {
  try {
    const saved = localStorage.getItem(lastPaymentKey(kind));
    return PAYMENT_LABELS[saved] ? saved : 'PIX';
  } catch {
    return 'PIX';
  }
}

export function sectionLabel(text) {
  return el('span', { class: 'stat-label' }, text);
}

/**
 * Cria os campos comuns. `kind` = 'revenue' | 'expense'; `entry` = lançamento em edição (opcional).
 * Retorna os nós para montar o formulário e read(), que valida e devolve o corpo ou null.
 */
export function commonFields(kind, entry = null) {
  const today = todayISO(config.TIMEZONE);
  const amount = el('input', {
    class: 'input', id: `${kind}-amount`, type: 'text', inputmode: 'decimal', autocomplete: 'off',
    placeholder: '0,00', maxlength: 16, value: centsToInput(entry?.amount_cents), 'aria-label': 'Valor',
  });
  const amountField = el('div', { class: 'field' },
    el('label', { for: amount.id }, 'Valor'),
    el('div', { class: 'money-field' }, el('span', { class: 'money-prefix' }, 'R$'), amount),
    el('span', { class: 'field-error', id: `${amount.id}-error` }),
  );

  const payment = chipGroup({
    label: 'Forma de pagamento',
    options: Object.entries(PAYMENT_LABELS).map(([value, label]) => ({ value, label })),
    value: entry?.payment_method ?? rememberedPayment(kind),
  });

  const date = field({ id: `${kind}-date`, label: 'Data', type: 'date', max: today, value: entry?.date ?? today });
  const description = field({ id: `${kind}-description`, label: 'Descrição', type: 'text', maxlength: 120, value: entry?.description ?? '' });
  const notes = el('div', { class: 'field' },
    el('label', { for: `${kind}-notes` }, 'Observação'),
    el('textarea', { class: 'input', id: `${kind}-notes`, maxlength: 500 }, entry?.notes ?? ''),
  );
  const more = el('details', { class: 'more', open: Boolean(entry) },
    el('summary', {}, entry ? 'Data, descrição e observação' : 'Mais opções (data, descrição, observação)'),
    el('div', { class: 'form' }, date, description, notes),
  );

  const input = (node) => node.querySelector('input, textarea');

  return {
    amount,
    amountField,
    paymentField: el('div', { class: 'field' }, sectionLabel('Forma de pagamento'), payment.element),
    more,
    descriptionInput: input(description),
    /** Valida (orientação ao usuário; o servidor valida de novo) e devolve o corpo ou null. */
    read() {
      const cents = parseMoneyToCents(amount.value);
      setFieldError(amount, cents ? null : 'Informe um valor maior que zero. Ex.: 70,50');
      const dateInput = input(date);
      const dateOk = isValidISODate(dateInput.value) && dateInput.value <= today;
      setFieldError(dateInput, dateOk ? null : 'Data inválida ou futura.');
      if (!dateOk) more.open = true;
      if (!cents) amount.focus();
      if (!cents || !dateOk) return null;
      return {
        amount_cents: cents,
        payment_method: payment.value,
        date: dateInput.value,
        description: input(description).value.trim(),
        notes: input(notes).value.trim(),
      };
    },
    rememberPayment() {
      try {
        localStorage.setItem(lastPaymentKey(kind), payment.value);
      } catch {
        // ignorado
      }
    },
  };
}

/** Corpo de edição: só os campos que mudaram. */
export function diff(entry, body) {
  return Object.fromEntries(Object.entries(body).filter(([key, value]) => entry[key] !== value));
}
