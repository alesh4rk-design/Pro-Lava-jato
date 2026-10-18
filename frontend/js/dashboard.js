// Dashboard: indicadores do período escolhido e resumo do mês.

import { session } from './app.js';
import { api } from './api.js';
import { formatCents, formatBasisPoints, formatInteger, formatDate } from './format.js';
import { PAYMENT_LABELS } from './entry-form.js';
import { openEntryDetail } from './entry-detail.js';
import { el, icon, stateView } from './ui.js';
import { periodPicker } from './periods.js';
import { config } from './config.js';
import { whenText } from './recorrentes-text.js';

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

/** Aviso de próximos vencimentos das despesas recorrentes (7 dias). Só para o administrador. */
async function loadDueAlert() {
  if (session.user.role !== 'ADMIN') return;
  try {
    const { items, total_cents: total } = await api.get('/recurring-expenses/upcoming?days=7');
    const box = document.getElementById('due-alert');
    if (!items.length) return;
    const urgent = items.some((i) => i.days_left <= 1);
    box.classList.toggle('is-urgent', urgent);
    box.replaceChildren(...[
      el('a', { class: 'due-alert-head', href: 'recorrentes.html' },
        icon('calendar', 'icon icon-sm'),
        el('strong', {}, urgent ? 'Vencimentos para hoje ou amanhã' : 'Próximos vencimentos'),
        icon('chevron-right', 'icon icon-sm')),
      el('ul', { class: 'due-alert-list' }, items.slice(0, 4).map((i) => el('li', { class: i.days_left <= 1 ? 'is-soon' : '' },
        el('span', { class: 'due-name' }, i.description || i.category_name),
        el('span', { class: 'due-when' }, `${whenText(i.days_left)} · ${formatDate(i.next_date).slice(0, 5)}`),
        el('strong', { class: 'num due-amount' }, formatCents(i.amount_cents))))),
      el('a', { class: 'due-alert-more', href: 'recorrentes.html' },
        items.length > 4 ? `Ver mais ${items.length - 4} · total da semana ${formatCents(total)}` : `Total dos próximos 7 dias: ${formatCents(total)}`),
    ]);
    box.hidden = false;
  } catch {
    // aviso complementar: falha aqui não atrapalha o dashboard
  }
}

/* Meu dia (operador): só o que a própria pessoa lançou hoje. Nada de totais, saldo ou lançamentos de outros. */

function myDayRow(item) {
  const isIn = item.kind === 'IN';
  const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: config.TIMEZONE }).format(new Date(item.created_at));
  return el('li', {},
    el('button', { class: `entry-row ${isIn ? 'is-in' : 'is-out'}`, type: 'button', onclick: () => openEntryDetail(item.kind, item.id, { isAdmin: false, onChanged: loadMyDay }) },
      el('span', { class: 'tile-icon' }, icon(isIn ? 'arrow-up' : 'arrow-down', 'icon icon-sm')),
      el('span', {}, el('strong', {}, item.title), el('small', {}, [PAYMENT_LABELS[item.payment_method], time].filter(Boolean).join(' · '))),
      el('span', { class: `entry-amount ${isIn ? 'text-success' : 'text-danger'}` }, `${isIn ? '+' : '−'}${formatCents(item.amount_cents)}`)));
}

async function loadMyDay() {
  try {
    const { items, revenue_count: revenues, expense_count: expenses } = await api.get('/my-day');
    content.replaceChildren(
      el('div', { class: 'card stat-hero' },
        el('div', { class: 'stat-label' }, 'Seus lançamentos de hoje'),
        el('div', { class: 'stat-value num' }, formatInteger(items.length)),
        el('div', { class: 'stat-hero-foot' }, el('span', {}, `${revenues} ${revenues === 1 ? 'receita' : 'receitas'} · ${expenses} ${expenses === 1 ? 'despesa' : 'despesas'}`))),
      items.length
        ? el('ul', { class: 'list entry-list' }, items.map(myDayRow))
        : stateView({ title: 'Nada lançado hoje', message: 'Use "Lançar" para registrar uma receita ou despesa.' }));
  } catch (error) {
    content.replaceChildren(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: loadMyDay }));
  }
}

function init() {
  if (!session) return;
  loadStockAlert();
  if (session.user.role !== 'ADMIN') {
    document.getElementById('period-chips').hidden = true;
    label.hidden = true;
    renderSkeleton();
    loadMyDay();
    return;
  }
  loadDueAlert();
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
