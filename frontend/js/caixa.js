// Caixa: entradas, saídas e saldo do período, por forma de pagamento, e a lista de lançamentos.

import { session } from './app.js';
import { api } from './api.js';
import { formatCents, formatDate } from './format.js';
import { el, icon, stateView } from './ui.js';
import { periodPicker } from './periods.js';
import { PAYMENT_LABELS } from './entry-form.js';
import { openEntryDetail } from './entry-detail.js';

const $ = (id) => document.getElementById(id);
const summary = $('cash-summary');
const list = $('cash-entries');
const loadMore = $('load-more');
const search = $('cash-search');

const state = { periodQuery: '', kind: '', method: '', cancelled: false, page: 1 };
let listSeq = 0;

/* Resumo ---------------------------------------------------------------------- */

function totalCell(label, cents, cls, extraClass = '') {
  return el('div', { class: extraClass },
    el('div', { class: 'stat-label' }, label),
    el('div', { class: `stat-value num ${cls}` }, formatCents(cents)),
  );
}

/** "+R$ 70,00 −R$ 25,00", omitindo a parte zerada. */
function methodAmounts(m) {
  return [
    m.in_cents ? el('strong', { class: 'text-success' }, `+${formatCents(m.in_cents)}`) : null,
    m.in_cents && m.out_cents ? ' ' : null,
    m.out_cents ? el('strong', { class: 'text-danger' }, `−${formatCents(m.out_cents)}`) : null,
  ];
}

function renderSummary({ totals, by_method: byMethod }) {
  const used = byMethod.filter((m) => m.count > 0);
  summary.replaceChildren(
    el('div', { class: 'cash-totals' },
      totalCell('Entradas', totals.in_cents, 'text-success'),
      totalCell('Saídas', totals.out_cents, 'text-danger'),
      totalCell('Saldo', totals.balance_cents, totals.balance_cents < 0 ? 'text-danger' : '', 'cash-balance'),
    ),
    used.length
      ? el('ul', { class: 'list cash-methods' }, used.map((m) => el('li', { class: 'list-row' },
        el('span', { class: 'muted' }, PAYMENT_LABELS[m.method]),
        el('span', {}, methodAmounts(m)))))
      : null,
  );
}

async function loadSummary() {
  summary.replaceChildren(el('div', { class: 'skeleton sk-line' }), el('div', { class: 'skeleton sk-value-sm' }));
  try {
    renderSummary(await api.get(`/cash?${state.periodQuery}`));
  } catch (error) {
    summary.replaceChildren(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: loadSummary }));
  }
}

/* Lançamentos ------------------------------------------------------------------- */

function entryRow(item) {
  const isIn = item.kind === 'IN';
  const cancelled = item.status === 'CANCELADO';
  const title = item.description || item.ref_name || (isIn ? 'Receita' : 'Despesa');
  const subtitle = [item.description ? item.ref_name : null, PAYMENT_LABELS[item.payment_method], formatDate(item.date)].filter(Boolean).join(' · ');
  return el('li', {},
    el('button', {
      class: `entry-row ${isIn ? 'is-in' : 'is-out'}${cancelled ? ' is-cancelled' : ''}`,
      type: 'button',
      onclick: () => openEntryDetail(item.kind, item.id, { isAdmin: session.user.role === 'ADMIN', onChanged: refresh }),
    },
    el('span', { class: 'tile-icon' }, icon(isIn ? 'arrow-up' : 'arrow-down', 'icon icon-sm')),
    el('span', {}, el('strong', {}, title), el('small', {}, cancelled ? `Cancelado · ${subtitle}` : subtitle)),
    el('span', { class: `entry-amount ${isIn ? 'text-success' : 'text-danger'}` }, `${isIn ? '+' : '−'}${formatCents(item.amount_cents)}`)),
  );
}

async function loadEntries({ append = false } = {}) {
  const seq = ++listSeq;
  state.page = append ? state.page + 1 : 1;
  const params = new URLSearchParams(state.periodQuery);
  if (state.kind) params.set('kind', state.kind);
  if (state.method) params.set('payment_method', state.method);
  if (state.cancelled) params.set('include_cancelled', '1');
  if (search.value.trim()) params.set('q', search.value.trim());
  params.set('page', String(state.page));

  if (!append) list.replaceChildren(el('li', { class: 'card' }, el('div', { class: 'skeleton sk-line' })));
  loadMore.hidden = true;
  try {
    const data = await api.get(`/cash/entries?${params}`);
    if (seq !== listSeq) return;
    const rows = data.items.map(entryRow);
    if (append) list.append(...rows);
    else if (rows.length) list.replaceChildren(...rows);
    else list.replaceChildren(el('li', {}, stateView({ title: 'Nenhum lançamento', message: 'Nada encontrado com estes filtros.' })));
    loadMore.hidden = !data.has_more;
  } catch (error) {
    if (seq !== listSeq) return;
    list.replaceChildren(el('li', {}, stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: () => loadEntries() })));
  }
}

function refresh() {
  loadSummary();
  loadEntries();
}

/* Filtros ------------------------------------------------------------------------ */

function setupChips(container, key, attribute) {
  const chips = container.querySelectorAll('.chip');
  chips.forEach((chip) => chip.addEventListener('click', () => {
    state[key] = chip.dataset[attribute];
    chips.forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    loadEntries();
  }));
}

function init() {
  if (!session) return;
  const methodChips = $('method-chips');
  methodChips.replaceChildren(
    el('button', { class: 'chip', type: 'button', 'data-method': '', 'aria-pressed': 'true' }, 'Todas'),
    ...Object.entries(PAYMENT_LABELS).map(([value, label]) => el('button', { class: 'chip', type: 'button', 'data-method': value, 'aria-pressed': 'false' }, label)),
  );
  setupChips(methodChips, 'method', 'method');
  setupChips($('kind-chips'), 'kind', 'kind');

  $('show-cancelled').addEventListener('change', (e) => {
    state.cancelled = e.target.checked;
    loadEntries();
  });
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => loadEntries(), 350);
  });
  loadMore.addEventListener('click', () => loadEntries({ append: true }));

  periodPicker({
    container: $('period-chips'),
    initial: 'today',
    storageKey: 'lj.caixa.period',
    onChange: ({ label, query }) => {
      $('period-label').textContent = label;
      state.periodQuery = query;
      refresh();
    },
  });
}

init();
