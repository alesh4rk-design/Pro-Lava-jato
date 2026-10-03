// Dashboard: indicadores do período escolhido e resumo do mês.

import { session } from './app.js';
import { api } from './api.js';
import { formatCents, formatBasisPoints, formatInteger, formatDate } from './format.js';
import { el, icon, stateView } from './ui.js';
import { periodPicker } from './periods.js';

const content = document.getElementById('dash-content');
const label = document.getElementById('period-label');
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

/** Alerta discreto quando há produtos abaixo do estoque mínimo. */
async function loadStockAlert() {
  try {
    const { items } = await api.get('/products?low_stock=1');
    const alert = document.getElementById('stock-alert');
    if (!items.length) return;
    alert.replaceChildren(icon('alert', 'icon icon-sm'),
      el('span', {}, items.length === 1 ? `${items[0].name} está com estoque baixo` : `${items.length} produtos com estoque baixo`),
      icon('chevron-right', 'icon icon-sm'));
    alert.hidden = false;
  } catch {
    // o alerta é complementar: falha aqui não atrapalha o dashboard
  }
}

function init() {
  if (!session) return;
  loadStockAlert();
  periodPicker({
    container: document.getElementById('period-chips'),
    storageKey: 'lj.dashboard.period',
    onChange: ({ label: text, query }) => {
      label.textContent = text;
      load(query);
    },
  });
}

init();
