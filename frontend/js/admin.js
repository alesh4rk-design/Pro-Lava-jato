// Painel do administrador do sistema: autorizar, bloquear e desbloquear acessos de clientes.

import { session } from './app.js';
import { api } from './api.js';
import { formatDate } from './format.js';
import { el, icon, toast, confirmDialog, stateView, setBusy } from './ui.js';

const STATUS = {
  PENDENTE: { label: 'Pendente', badge: 'badge-warning' },
  ATIVO: { label: 'Ativo', badge: 'badge-success' },
  BLOQUEADO: { label: 'Bloqueado', badge: 'badge-danger' },
};

const ACTIONS = {
  approve: {
    label: 'Autorizar', icon: 'check', variant: 'btn-success', done: 'Acesso autorizado.',
    confirm: (t) => ({ title: 'Autorizar acesso?', message: `${t.business_name} poderá entrar no sistema.`, confirmLabel: 'Autorizar' }),
  },
  block: {
    label: 'Bloquear', icon: 'ban', variant: 'btn-outline', done: 'Acesso bloqueado.',
    confirm: (t) => ({ title: 'Bloquear acesso?', message: `Todos os usuários de ${t.business_name} serão desconectados e não conseguirão entrar. Os dados são mantidos.`, confirmLabel: 'Bloquear', danger: true }),
  },
  unblock: {
    label: 'Desbloquear', icon: 'unlock', variant: 'btn-primary', done: 'Acesso liberado.',
    confirm: (t) => ({ title: 'Desbloquear acesso?', message: `${t.business_name} voltará a ter acesso ao sistema.`, confirmLabel: 'Desbloquear' }),
  },
};

const ACTIONS_BY_STATUS = { PENDENTE: ['block', 'approve'], ATIVO: ['block'], BLOQUEADO: ['unblock'] };

const list = document.getElementById('tenant-list');
const search = document.getElementById('tenant-search');
const chips = document.querySelectorAll('#status-chips .chip');
let currentStatus = 'PENDENTE';
let items = [];

async function runAction(tenant, action, button) {
  const ok = await confirmDialog(ACTIONS[action].confirm(tenant));
  if (!ok) return;
  setBusy(button, true);
  try {
    await api.post(`/system/tenants/${encodeURIComponent(tenant.id)}/${action}`);
    toast(ACTIONS[action].done, { type: 'success' });
    await load();
  } catch (error) {
    toast(error.message, { type: 'error' });
    setBusy(button, false);
  }
}

function tenantCard(tenant) {
  const status = STATUS[tenant.status] ?? { label: tenant.status, badge: '' };
  const actions = (ACTIONS_BY_STATUS[tenant.status] ?? []).map((action) => {
    const def = ACTIONS[action];
    const button = el('button', { class: `btn ${def.variant}`, type: 'button' }, icon(def.icon, 'icon icon-sm'), def.label);
    button.addEventListener('click', () => runAction(tenant, action, button));
    return button;
  });

  return el('article', { class: 'card tenant-card' },
    el('div', { class: 'tenant-card-head' },
      el('h3', {}, tenant.business_name),
      el('span', { class: `badge ${status.badge}` }, status.label),
    ),
    el('div', { class: 'tenant-meta' },
      el('span', {}, tenant.owner_name),
      el('span', {}, tenant.email),
      tenant.phone ? el('span', {}, tenant.phone) : null,
      el('span', {}, `Cadastro em ${formatDate(tenant.created_at)}`),
    ),
    actions.length ? el('div', { class: 'tenant-actions' }, actions) : null,
  );
}

function render() {
  const term = search.value.trim().toLowerCase();
  const visible = term
    ? items.filter((t) => `${t.business_name} ${t.owner_name} ${t.email}`.toLowerCase().includes(term))
    : items;

  if (!visible.length) {
    list.replaceChildren(stateView({
      title: term ? 'Nenhum cliente encontrado' : 'Nada por aqui',
      message: term ? 'Tente buscar por outro nome ou e-mail.' : 'Nenhum cliente nesta situação.',
    }));
    return;
  }
  list.replaceChildren(...visible.map(tenantCard));
}

async function load() {
  list.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'skeleton sk-line' }), el('div', { class: 'skeleton sk-value-sm' })));
  try {
    const query = currentStatus ? `?status=${encodeURIComponent(currentStatus)}` : '';
    const data = await api.get(`/system/tenants${query}`);
    items = data.items;
    Object.entries(data.counts).forEach(([key, value]) => {
      const node = document.getElementById(`count-${key}`);
      if (node) node.textContent = String(value);
    });
    render();
  } catch (error) {
    list.replaceChildren(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: load }));
  }
}

function init() {
  if (!session) return;
  chips.forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.status === currentStatus));
    chip.addEventListener('click', () => {
      currentStatus = chip.dataset.status;
      chips.forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      load();
    });
  });
  search.addEventListener('input', render);
  load();
}

init();
