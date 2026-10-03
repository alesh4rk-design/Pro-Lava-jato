// Formulário de despesa (novo lançamento e edição). O tipo segue o padrão da categoria escolhida.

import { api } from './api.js';
import { formatCents } from './format.js';
import { el, chipGroup, openModal, toast, runBusy } from './ui.js';
import { getCategories } from './catalog.js';
import { commonFields, sectionLabel, diff, EXPENSE_TYPE_LABELS } from './entry-form.js';

export async function openExpenseForm({ entry = null, onSaved } = {}) {
  let categories = [];
  try {
    categories = await getCategories('DESPESA');
  } catch (error) {
    toast(error.message, { type: 'error' });
    return;
  }

  const common = commonFields('expense', entry);
  const type = chipGroup({
    label: 'Tipo',
    options: Object.entries(EXPENSE_TYPE_LABELS).map(([value, label]) => ({ value, label })),
    value: entry?.type ?? null,
  });
  const category = chipGroup({
    label: 'Categoria',
    options: categories.map((c) => ({ value: c.id, label: c.name, type: c.default_expense_type })),
    value: entry?.category_id ?? null,
    onChange: (opt) => { if (opt.type) type.value = opt.type; },
  });
  const categoryError = el('span', { class: 'field-error' });

  const form = el('form', { class: 'form', novalidate: true },
    common.amountField,
    el('div', { class: 'field' },
      sectionLabel('Categoria'),
      categories.length ? category.element : el('p', { class: 'hint' }, 'Nenhuma categoria ativa. Peça ao administrador para cadastrar.'),
      categoryError,
    ),
    el('div', { class: 'field' },
      sectionLabel('Tipo'),
      type.element,
      el('span', { class: 'hint' }, 'Custo variável acompanha os serviços (produtos, materiais). Fixa se repete todo mês (aluguel, salários).'),
    ),
    common.paymentField,
    common.more,
  );

  openModal({
    title: entry ? 'Editar despesa' : 'Nova despesa',
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: entry ? 'Salvar' : 'Registrar',
        variant: 'btn-danger',
        onClick: async (close, button) => {
          const body = common.read();
          categoryError.textContent = category.value ? '' : 'Escolha a categoria.';
          if (!body || !category.value) return;
          body.category_id = category.value;
          if (type.value) body.type = type.value;

          const saved = await runBusy(button, () => (entry
            ? api.put(`/expenses/${encodeURIComponent(entry.id)}`, diff(entry, body))
            : api.post('/expenses', body)));
          if (!saved) return;
          common.rememberPayment();
          close();
          toast(`Despesa de ${formatCents(saved.amount_cents)} ${entry ? 'atualizada' : 'registrada'}.`, { type: 'success' });
          onSaved?.(saved);
        },
      },
    ],
  });
  if (!entry) common.amount.focus();
}
