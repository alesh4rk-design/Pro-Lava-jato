// Dashboard: indicadores do período escolhido e resumo do mês.

import { session } from './app.js';
import { api } from './api.js';
import { config } from './config.js';
import { formatCents, formatBasisPoints, formatInteger, formatDate, isValidISODate, todayISO } from './format.js';
import { el, openModal, stateView, setFieldError } from './ui.js';

const PERIOD_LABELS = {
  today: 'Hoje',
  '7d': 'Últimos 7 dias',
  month: 'Este mês',
  last_month: 'Mês anterior',
  year: 'Este ano',
};
const STORAGE_KEY = 'lj.dashboard.period';

const content = document.getElementById('dash-content');
const label = document.getElementById('period-label');
const chips = document.querySelectorAll('#period-chips .chip');
const cache = new Map();
let requestSeq = 0;

function stat(title, value, dotClass) {
  return el('div', { class: 'card' },
    el('div', { class: 'stat-label' }, dotClass ? el('span', { class: `dot ${dotClass}` }) : null, title),
    el('div', { class: 'stat-value num' }, value),
  );
}

function row(title, value, valueClass = '') {
  return el('li', { class: 'list-row' }, el('span', { class: 'muted' }, title), el('strong', { class: valueClass }, value));
}

function renderSkeleton() {
  const skeletonCard = () => el('div', { class: 'card' }, el('div', { class: 'skeleton sk-line' }), el('div', { class: 'skeleton sk-value-sm' }));
  content.replaceChildren(
    el('div', { class: 'card stat-hero', 'aria-busy': 'true' }, el('div', { class: 'skeleton sk-line' }), el('div', { class: 'skeleton sk-value' })),
    el('div', { class: 'grid-2' }, [1, 2, 3, 4].map(skeletonCard)),
  );
}

function renderData({ period, totals, snapshot }) {
  label.textContent = period.start === period.end
    ? formatDate(period.start)
    : `${formatDate(period.start).slice(0, 5)} a ${formatDate(period.end)}`;

  if (totals.revenue_cents === 0 && totals.variable_costs_cents === 0 && totals.expenses_cents === 0) {
    content.replaceChildren(stateView({
      title: 'Nenhum lançamento no período',
      message: 'Registre receitas e despesas para acompanhar o resultado.',
    }));
    return;
  }

  const loss = totals.result_cents < 0;
  content.replaceChildren(
    el('div', { class: 'card stat-hero' },
      el('div', { class: 'stat-label' }, 'Resultado do período'),
      el('div', { class: 'stat-value num' }, formatCents(totals.result_cents)),
      el('div', { class: 'stat-hero-foot' },
        el('span', {}, `Margem ${formatBasisPoints(totals.margin_bp)}`),
        el('span', { class: `badge ${loss ? 'badge-danger' : 'badge-success'}` }, loss ? 'Prejuízo' : 'Lucro'),
      ),
    ),
    el('div', { class: 'grid-2' },
      stat('Faturamento', formatCents(totals.revenue_cents), 'dot-success'),
      stat('Custos', formatCents(totals.variable_costs_cents), 'dot-warning'),
      stat('Despesas', formatCents(totals.expenses_cents), 'dot-danger'),
      stat('Margem', formatBasisPoints(totals.margin_bp), 'dot-primary'),
      stat('Ticket médio', formatCents(totals.avg_ticket_cents)),
      stat('Serviços', formatInteger(totals.services_count)),
    ),
    el('h2', { class: 'section-title' }, 'Resumo do mês'),
    el('ul', { class: 'card list' },
      row('Receita de hoje', formatCents(snapshot.revenue_today_cents)),
      row('Receita da semana', formatCents(snapshot.revenue_week_cents)),
      row('Receita do mês', formatCents(snapshot.revenue_month_cents), 'text-success'),
      row('Custos do mês', formatCents(snapshot.costs_month_cents)),
      row('Despesas do mês', formatCents(snapshot.expenses_month_cents)),
      row('Resultado do mês', formatCents(snapshot.result_month_cents), snapshot.result_month_cents < 0 ? 'text-danger' : 'text-success'),
    ),
  );
}

async function load(query) {
  const seq = ++requestSeq;
  if (cache.has(query)) {
    renderData(cache.get(query));
    return;
  }
  renderSkeleton();
  try {
    const data = await api.get(`/dashboard?${query}`);
    cache.set(query, data);
    if (seq === requestSeq) renderData(data);
  } catch (error) {
    if (seq !== requestSeq) return;
    content.replaceChildren(stateView({
      type: 'error',
      title: 'Não foi possível carregar',
      message: error.message,
      actionLabel: 'Tentar novamente',
      onAction: () => load(query),
    }));
  }
}

function selectChip(period) {
  chips.forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.period === period)));
}

function selectPeriod(period) {
  selectChip(period);
  label.textContent = PERIOD_LABELS[period] ?? '';
  try {
    sessionStorage.setItem(STORAGE_KEY, period);
  } catch {
    // ignorado
  }
  load(new URLSearchParams({ period }).toString());
}

function dateField(id, text, value) {
  return el('div', { class: 'field' },
    el('label', { for: id }, text),
    el('input', { class: 'input', id, type: 'date', value, required: true }),
    el('span', { class: 'field-error', id: `${id}-error` }),
  );
}

function openCustomPeriod() {
  const today = todayISO(config.TIMEZONE);
  const form = el('form', { class: 'form', novalidate: true },
    dateField('custom-start', 'De', `${today.slice(0, 8)}01`),
    dateField('custom-end', 'Até', today),
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
          const start = form.querySelector('#custom-start');
          const end = form.querySelector('#custom-end');
          setFieldError(start, isValidISODate(start.value) ? null : 'Data inválida.');
          const endError = !isValidISODate(end.value) ? 'Data inválida.' : end.value < start.value ? 'Deve ser depois da data inicial.' : null;
          setFieldError(end, endError);
          if (!isValidISODate(start.value) || endError) return;
          close();
          selectChip('custom');
          load(new URLSearchParams({ period: 'custom', start: start.value, end: end.value }).toString());
        },
      },
    ],
  });
}

function init() {
  if (!session) return;
  chips.forEach((chip) => chip.addEventListener('click', () => {
    if (chip.dataset.period === 'custom') openCustomPeriod();
    else selectPeriod(chip.dataset.period);
  }));
  let initial = 'month';
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved && PERIOD_LABELS[saved]) initial = saved;
  } catch {
    // ignorado
  }
  selectPeriod(initial);
}

init();
