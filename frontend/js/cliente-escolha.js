// Escolha do cliente que está fazendo a limpeza (opcional), dentro do formulário de receita.
// Busca por nome, telefone ou placa; se o cliente ainda não existe, cadastra na hora (nome e telefone).

import { api } from './api.js';
import { formatPhone } from './format.js';
import { el, icon, field, toast, openModal, runBusy, validateFields } from './ui.js';
import { vehicleText } from './whatsapp.js';
import { nameFromSearch } from './cliente-busca.js';

const MAX_SHOWN = 5;


function openQuickCustomer(initialName, onCreated) {
  const form = el('form', { class: 'form', novalidate: true },
    field({ id: 'qc-name', label: 'Nome', type: 'text', maxlength: 80, value: initialName, autocomplete: 'off' }),
    field({ id: 'qc-phone', label: 'Telefone / WhatsApp (com DDD)', type: 'tel', inputmode: 'tel', maxlength: 20, placeholder: '(11) 98888-7777' }),
    field({ id: 'qc-vehicle', label: 'Veículo (opcional)', type: 'text', maxlength: 60, placeholder: 'Ex.: Gol branco', autocomplete: 'off' }),
    field({ id: 'qc-plate', label: 'Placa (opcional)', type: 'text', maxlength: 8, placeholder: 'ABC1D23', autocapitalize: 'characters', autocomplete: 'off' }),
  );
  openModal({
    title: 'Novo cliente',
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Cadastrar',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const [name, phone, vehicle, plate] = ['qc-name', 'qc-phone', 'qc-vehicle', 'qc-plate'].map((id) => form.querySelector(`#${id}`));
          const digits = phone.value.replace(/\D/g, '');
          const ok = validateFields([
            [name, (v) => (v.trim().length >= 2 ? null : 'Informe o nome.')],
            [phone, () => (digits.length >= 10 && digits.length <= 13 ? null : 'Telefone inválido. Use DDD + número.')],
            [plate, (v) => (!v.trim() || /^[A-Za-z0-9]{5,8}$/.test(v.replace(/[\s-]/g, '')) ? null : 'Placa inválida. Ex.: ABC1D23')],
          ]);
          if (!ok) return;
          const created = await runBusy(button, () => api.post('/customers', { name: name.value.trim(), phone: phone.value.trim(), vehicle: vehicle.value.trim(), plate: plate.value.trim() }));
          if (!created) return;
          close();
          toast('Cliente cadastrado.', { type: 'success' });
          onCreated(created);
        },
      },
    ],
  });
}

/**
 * Seletor de cliente. Retorna { element, get id(), get name() }.
 * `initial`: { id, name } do cliente já ligado (edição de receita).
 */
export function customerPicker({ initial = null } = {}) {
  let selected = initial?.id ? { id: initial.id, name: initial.name ?? 'Cliente' } : null;
  let timer;
  let seq = 0;

  const input = el('input', {
    class: 'input', id: 'customer-pick', type: 'search', maxlength: 60, autocomplete: 'off',
    placeholder: 'Buscar por nome, telefone ou placa', 'aria-label': 'Buscar cliente',
  });
  const results = el('div', { class: 'chips chips-wrap customer-results', role: 'group', 'aria-label': 'Clientes encontrados' });
  const chosen = el('div', { class: 'customer-chosen' });
  const searchBox = el('div', { class: 'customer-search' }, input, results);

  const paint = () => {
    chosen.replaceChildren();
    chosen.hidden = !selected;
    searchBox.hidden = Boolean(selected);
    if (selected) {
      chosen.append(
        el('span', { class: 'badge badge-primary customer-name' }, icon('check', 'icon icon-sm'), selected.name),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { selected = null; paint(); input.focus(); } }, 'Trocar'),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': 'Tirar o cliente', onclick: () => { selected = null; paint(); } }, 'Remover'));
    }
  };
  const pick = (customer) => { selected = { id: customer.id, name: customer.name }; input.value = ''; results.replaceChildren(); paint(); };

  const search = async () => {
    const mine = ++seq;
    const q = input.value.trim();
    try {
      const params = new URLSearchParams({ page: '1' });
      if (q) params.set('q', q);
      const { items } = await api.get(`/customers?${params}`);
      if (mine !== seq) return;
      const buttons = items.slice(0, MAX_SHOWN).map((c) => el('button', {
        class: 'chip', type: 'button', onclick: () => pick(c),
      }, c.name, el('small', { class: 'chip-hint' }, [vehicleText(c), formatPhone(c.phone)].filter(Boolean).join(' · '))));
      const create = el('button', { class: 'chip chip-new', type: 'button', onclick: () => openQuickCustomer(nameFromSearch(input.value), pick) }, '+ Novo cliente');
      results.replaceChildren(...buttons, create);
    } catch {
      results.replaceChildren(el('span', { class: 'hint' }, 'Não foi possível buscar clientes agora.'));
    }
  };

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
  input.addEventListener('focus', () => { if (!results.children.length) search(); });
  paint();

  return {
    element: el('div', { class: 'field customer-picker' }, el('label', { for: 'customer-pick' }, 'Cliente ', el('span', { class: 'muted' }, '(opcional)')), chosen, searchBox),
    get id() { return selected?.id ?? null; },
    get name() { return selected?.name ?? null; },
  };
}
