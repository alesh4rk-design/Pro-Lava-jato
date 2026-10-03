// Categorias (somente ADMIN): criar, renomear, definir o tipo padrão e ativar/desativar.

import { session } from './app.js';
import { api } from './api.js';
import { el, icon, field, chipGroup, toast, openModal, stateView, runBusy, validateFields } from './ui.js';
import { EXPENSE_TYPE_LABELS, sectionLabel } from './entry-form.js';
import { invalidateCatalog } from './catalog.js';

const HINTS = {
  DESPESA: 'Usadas ao lançar despesas. O tipo padrão define se entra como custo variável, despesa fixa ou outra.',
  PRODUTO: 'Usadas para agrupar produtos e insumos (Etapa 4).',
};

const list = document.getElementById('category-list');
let kind = 'DESPESA';

const nameRule = (v) => (v.trim() ? null : 'Informe o nome.');

function typeSelector(value) {
  return chipGroup({
    label: 'Tipo padrão',
    options: Object.entries(EXPENSE_TYPE_LABELS).map(([v, label]) => ({ value: v, label })),
    value: value ?? 'OUTRA',
  });
}

function openForm(category = null) {
  const isExpense = (category?.kind ?? kind) === 'DESPESA';
  const type = isExpense ? typeSelector(category?.default_expense_type) : null;
  const active = el('input', { type: 'checkbox', id: 'c-active', checked: category ? category.active : true });
  const form = el('form', { class: 'form', novalidate: true },
    field({ id: 'c-name', label: 'Nome', type: 'text', maxlength: 60, value: category?.name ?? '', autocomplete: 'off' }),
    type ? el('div', { class: 'field' }, sectionLabel('Tipo padrão'), type.element) : null,
    category ? el('label', { class: 'switch', for: 'c-active' }, 'Categoria ativa', active) : null,
    category ? el('p', { class: 'hint' }, 'Desativar esconde a categoria dos novos lançamentos; o histórico é mantido.') : null,
  );

  openModal({
    title: category ? 'Editar categoria' : `Nova categoria de ${kind === 'DESPESA' ? 'despesa' : 'produto'}`,
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Salvar',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const name = form.querySelector('#c-name');
          if (!validateFields([[name, nameRule]])) return;
          const body = { name: name.value.trim() };
          if (type) body.default_expense_type = type.value;
          if (category) body.active = active.checked;
          else body.kind = kind;

          const saved = await runBusy(button, () => (category
            ? api.put(`/categories/${encodeURIComponent(category.id)}`, body)
            : api.post('/categories', body)));
          if (!saved) return;
          invalidateCatalog();
          close();
          toast(category ? 'Categoria atualizada.' : 'Categoria criada.', { type: 'success' });
          load();
        },
      },
    ],
  });
}

function categoryCard(category) {
  return el('button', { class: 'card tenant-card user-card', type: 'button', onclick: () => openForm(category) },
    el('div', { class: 'tenant-card-head' },
      el('h3', {}, category.name),
      category.active ? null : el('span', { class: 'badge badge-danger' }, 'Inativa'),
    ),
    el('div', { class: 'tenant-actions' },
      category.default_expense_type ? el('span', { class: 'badge badge-primary' }, EXPENSE_TYPE_LABELS[category.default_expense_type]) : null,
      el('span', { class: 'chevron' }, icon('chevron-right', 'icon icon-sm')),
    ),
  );
}

async function load() {
  document.getElementById('kind-hint').textContent = HINTS[kind];
  list.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'skeleton sk-line' })));
  try {
    const { items } = await api.get(`/categories?kind=${kind}&include_inactive=1`);
    list.replaceChildren(...(items.length ? items.map(categoryCard) : [stateView({ title: 'Nenhuma categoria', message: 'Crie a primeira em "Nova".' })]));
  } catch (error) {
    list.replaceChildren(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: load }));
  }
}

if (session) {
  const chips = document.querySelectorAll('#kind-chips .chip');
  chips.forEach((chip) => chip.addEventListener('click', () => {
    kind = chip.dataset.kind;
    chips.forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    load();
  }));
  document.getElementById('new-category').addEventListener('click', () => openForm());
  load();
}
