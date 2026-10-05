// Auditoria: do lava-jato (ADMIN) ou da plataforma (administrador do sistema), conforme a página.

import { session } from './app.js';
import { api } from './api.js';
import { config } from './config.js';
import { formatDateTime } from './format.js';
import { el, stateView } from './ui.js';
import { periodPicker } from './periods.js';
import { describeAudit, AUDIT_GROUPS } from './audit-labels.js';

const isSystem = document.body.dataset.scope === 'system';
const endpoint = isSystem ? '/system/audit' : '/audit';
const list = document.getElementById('audit-list');
const loadMore = document.getElementById('load-more');
const state = { periodQuery: '', group: '', page: 1 };
let seq = 0;

function row(item) {
  const { actor, title, detail } = describeAudit(item);
  const alert = ['LOGIN_FAILED', 'SYSTEM_LOGIN_FAILED', 'TENANT_BLOCKED'].includes(item.action) || item.action.endsWith('_CANCELLED');
  return el('li', { class: `audit-row${alert ? ' is-alert' : ''}` },
    el('div', { class: 'audit-meta' },
      el('strong', {}, actor),
      el('span', { class: 'hint' }, formatDateTime(item.created_at, config.TIMEZONE))),
    el('p', { class: 'audit-title' }, title),
    detail ? el('p', { class: 'hint audit-detail' }, detail) : null);
}

async function load({ append = false } = {}) {
  const id = ++seq;
  state.page = append ? state.page + 1 : 1;
  const params = new URLSearchParams(state.periodQuery);
  if (state.group) params.set('group', state.group);
  params.set('page', String(state.page));
  if (!append) list.replaceChildren(el('li', { class: 'card' }, el('div', { class: 'skeleton sk-line' })));
  loadMore.hidden = true;
  try {
    const data = await api.get(`${endpoint}?${params}`);
    if (id !== seq) return;
    const rows = data.items.map(row);
    if (append) list.append(...rows);
    else list.replaceChildren(...(rows.length ? rows : [el('li', {}, stateView({ title: 'Nenhum registro', message: 'Nada aconteceu neste período com estes filtros.' }))]));
    loadMore.hidden = !data.has_more;
  } catch (error) {
    if (id !== seq) return;
    list.replaceChildren(el('li', {}, stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: () => load() })));
  }
}

function init() {
  if (!session) return;
  const groups = document.getElementById('group-chips');
  if (isSystem) {
    groups.hidden = true;
  } else {
    groups.replaceChildren(...Object.entries(AUDIT_GROUPS).map(([value, label]) => el('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(value === ''), 'data-group': value,
    }, label)));
    groups.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
      state.group = chip.dataset.group;
      groups.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      load();
    }));
  }
  loadMore.addEventListener('click', () => load({ append: true }));
  periodPicker({
    container: document.getElementById('period-chips'),
    initial: 'today',
    storageKey: isSystem ? 'lj.admin-auditoria.period' : 'lj.auditoria.period',
    onChange: ({ label, query }) => {
      document.getElementById('period-label').textContent = label;
      state.periodQuery = query;
      load();
    },
  });
}

init();
