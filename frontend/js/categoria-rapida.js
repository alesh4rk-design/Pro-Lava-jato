// Criar categoria de despesa sem sair do lançamento (somente administrador).

import { api } from './api.js';
import { getSession } from './session.js';
import { el, field, chipGroup, toast, openModal, runBusy, validateFields } from './ui.js';
import { EXPENSE_TYPE_LABELS, sectionLabel } from './entry-form.js';
import { invalidateCatalog, getCategories } from './catalog.js';

export const canCreateCategory = () => getSession()?.user?.role === 'ADMIN';

/** Botão "+ Nova categoria". Depois de criar, chama onCreated(categoria) com a lista de categorias já atualizada. */
export function newCategoryButton(onCreated) {
  if (!canCreateCategory()) return null;
  return el('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openNewCategory(onCreated) }, '+ Nova categoria');
}

function openNewCategory(onCreated) {
  const type = chipGroup({ label: 'Tipo padrão', options: Object.entries(EXPENSE_TYPE_LABELS).map(([value, label]) => ({ value, label })), value: 'OUTRA' });
  const form = el('form', { class: 'form', novalidate: true },
    field({ id: 'nc-name', label: 'Nome da categoria', type: 'text', maxlength: 60, autocomplete: 'off', placeholder: 'Ex.: Energia elétrica' }),
    el('div', { class: 'field' }, sectionLabel('Tipo padrão'), type.element,
      el('span', { class: 'hint' }, 'Custo variável acompanha os serviços (produtos, materiais). Fixa se repete (aluguel, salários).')),
  );
  openModal({
    title: 'Nova categoria de despesa',
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Criar',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const name = form.querySelector('#nc-name');
          if (!validateFields([[name, (v) => (v.trim() ? null : 'Informe o nome.')]])) return;
          const created = await runBusy(button, () => api.post('/categories', { name: name.value.trim(), kind: 'DESPESA', default_expense_type: type.value }));
          if (!created) return;
          invalidateCatalog();
          close();
          toast('Categoria criada.', { type: 'success' });
          onCreated(created, await getCategories('DESPESA'));
        },
      },
    ],
  });
}
