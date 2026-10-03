// Seletor de período (chips + período personalizado), compartilhado por Início e Caixa.
// O servidor resolve as datas de cada chave no fuso do lava-jato; aqui só montamos a query.

import { config } from './config.js';
import { isValidISODate, todayISO } from './format.js';
import { el, openModal, field, validateFields } from './ui.js';

export const PERIODS = {
  today: 'Hoje',
  '7d': '7 dias',
  month: 'Este mês',
  last_month: 'Mês anterior',
  year: 'Este ano',
  custom: 'Personalizado',
};

function openCustom(current, onApply) {
  const today = todayISO(config.TIMEZONE);
  const form = el('form', { class: 'form', novalidate: true },
    field({ id: 'period-start', label: 'De', type: 'date', max: today, value: current?.start ?? `${today.slice(0, 8)}01` }),
    field({ id: 'period-end', label: 'Até', type: 'date', max: today, value: current?.end ?? today }),
  );
  openModal({
    title: 'Período personalizado',
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Aplicar',
        variant: 'btn-primary',
        onClick: (close) => {
          const start = form.querySelector('#period-start');
          const end = form.querySelector('#period-end');
          const valid = validateFields([
            [start, (val) => (isValidISODate(val) ? null : 'Data inválida.')],
            [end, (val) => (!isValidISODate(val) ? 'Data inválida.' : val < start.value ? 'Deve ser depois da data inicial.' : null)],
          ]);
          if (!valid) return;
          close();
          onApply({ start: start.value, end: end.value });
        },
      },
    ],
  });
}

/**
 * Monta os chips no container e chama onChange({ key, query }) a cada seleção.
 * A escolha fica salva na sessão do navegador (storageKey), exceto o período personalizado.
 */
export function periodPicker({ container, keys = Object.keys(PERIODS), initial = 'month', storageKey, onChange }) {
  let custom = null;
  const chips = keys.map((key) => el('button', { class: 'chip', type: 'button', 'data-period': key }, PERIODS[key]));
  container.replaceChildren(...chips);

  function emit(key) {
    chips.forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.period === key)));
    const params = new URLSearchParams({ period: key });
    if (key === 'custom') {
      params.set('start', custom.start);
      params.set('end', custom.end);
    } else if (storageKey) {
      try {
        sessionStorage.setItem(storageKey, key);
      } catch {
        // armazenamento indisponível: só não lembra a escolha
      }
    }
    onChange({ key, label: PERIODS[key], query: params.toString() });
  }

  chips.forEach((chip) => chip.addEventListener('click', () => {
    const key = chip.dataset.period;
    if (key === 'custom') {
      openCustom(custom, (range) => {
        custom = range;
        emit('custom');
      });
    } else {
      emit(key);
    }
  }));

  let start = initial;
  try {
    const saved = storageKey && sessionStorage.getItem(storageKey);
    if (saved && keys.includes(saved) && saved !== 'custom') start = saved;
  } catch {
    // ignorado
  }
  emit(start);
}
