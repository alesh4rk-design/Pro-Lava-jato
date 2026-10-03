// Movimentação de estoque: compra (entrada), consumo (saída) e ajuste por contagem (só ADMIN).
// A compra pode lançar a despesa no caixa na mesma operação.

import { api } from './api.js';
import { formatQty, formatCents, parseMoneyToCents } from './format.js';
import { el, chipGroup, openModal, toast, runBusy, setFieldError } from './ui.js';
import { getProducts, getCategories, invalidateCatalog } from './catalog.js';
import { qtyField, sectionLabel, PAYMENT_LABELS } from './entry-form.js';

const TYPES = {
  ENTRADA: { label: 'Compra', verb: 'Compra registrada' },
  SAIDA: { label: 'Consumo', verb: 'Consumo registrado' },
  AJUSTE: { label: 'Ajuste', verb: 'Estoque ajustado' },
};

function moneyInput(id) {
  const input = el('input', { class: 'input', id, type: 'text', inputmode: 'decimal', placeholder: '0,00', maxlength: 16, autocomplete: 'off' });
  return {
    input,
    element: el('div', { class: 'field' },
      el('label', { for: id }, 'Valor pago (total)'),
      el('div', { class: 'money-field' }, el('span', { class: 'money-prefix' }, 'R$'), input),
      el('span', { class: 'field-error', id: `${id}-error` })),
  };
}

/** Campos de cada tipo de movimentação. Retorna { element, read() -> corpo | null }. */
async function buildFields(type, product) {
  const reason = el('input', { class: 'input', id: 'mv-reason', type: 'text', maxlength: 200, autocomplete: 'off' });
  const reasonField = (label) => el('div', { class: 'field' }, el('label', { for: 'mv-reason' }, label), reason,
    el('span', { class: 'field-error', id: 'mv-reason-error' }));

  if (type === 'SAIDA') {
    const qty = qtyField({ id: 'mv-qty', label: 'Quantidade usada', unit: product.unit, initialBig: false, hint: `Em estoque: ${formatQty(product.stock_qty, product.unit)}` });
    return {
      element: el('div', { class: 'form' }, qty.element, reasonField('Observação (opcional)')),
      read: () => { const q = qty.read(); return q === null ? null : { type, qty: q, reason: reason.value.trim() }; },
    };
  }

  if (type === 'AJUSTE') {
    const qty = qtyField({ id: 'mv-qty', label: 'Quantidade contada', unit: product.unit, allowZero: true, hint: `O sistema registra ${formatQty(product.stock_qty, product.unit)}` });
    return {
      element: el('div', { class: 'form' }, qty.element, reasonField('Motivo do ajuste')),
      read: () => {
        const q = qty.read();
        setFieldError(reason, reason.value.trim() ? null : 'Informe o motivo.');
        return q === null || !reason.value.trim() ? null : { type, counted_qty: q, reason: reason.value.trim() };
      },
    };
  }

  // Compra
  const qty = qtyField({ id: 'mv-qty', label: 'Quantidade comprada', unit: product.unit });
  const money = moneyInput('mv-total');
  const register = el('input', { type: 'checkbox', id: 'mv-register', checked: true });
  const categories = (await getCategories('DESPESA')).filter((c) => c.default_expense_type === 'CUSTO_VARIAVEL');
  const category = chipGroup({
    label: 'Categoria da despesa',
    options: (categories.length ? categories : await getCategories('DESPESA')).map((c) => ({ value: c.id, label: c.name })),
  });
  category.value = categories[0]?.id;
  const payment = chipGroup({ label: 'Forma de pagamento', options: Object.entries(PAYMENT_LABELS).map(([value, label]) => ({ value, label })), value: 'PIX' });
  const expenseFields = el('div', { class: 'form' },
    el('div', { class: 'field' }, sectionLabel('Forma de pagamento'), payment.element),
    el('div', { class: 'field' }, sectionLabel('Categoria da despesa'), category.element));
  register.addEventListener('change', () => { expenseFields.hidden = !register.checked; });

  return {
    element: el('div', { class: 'form' },
      qty.element,
      money.element,
      el('label', { class: 'switch', for: 'mv-register' }, 'Lançar a despesa no caixa', register),
      expenseFields),
    read: () => {
      const q = qty.read();
      const cents = parseMoneyToCents(money.input.value);
      setFieldError(money.input, cents ? null : 'Informe o valor pago.');
      if (q === null || !cents) return null;
      const body = { type, qty: q, total_cost_cents: cents, register_expense: register.checked };
      if (register.checked) {
        if (!category.value) { toast('Escolha a categoria da despesa.', { type: 'error' }); return null; }
        Object.assign(body, { payment_method: payment.value, expense_category_id: category.value });
      }
      return body;
    },
  };
}

async function openForProduct(product, { isAdmin, onSaved, initialType = 'ENTRADA' }) {
  const allowed = isAdmin ? ['ENTRADA', 'SAIDA', 'AJUSTE'] : ['ENTRADA', 'SAIDA'];
  const container = el('div', {});
  let current = null;

  async function show(type) {
    try {
      current = await buildFields(type, product);
      container.replaceChildren(current.element);
    } catch (error) {
      toast(error.message, { type: 'error' });
    }
  }
  const typeChips = chipGroup({
    label: 'Tipo de movimentação',
    options: allowed.map((value) => ({ value, label: TYPES[value].label })),
    value: initialType,
    onChange: (opt) => show(opt.value),
  });
  await show(initialType);

  openModal({
    title: product.name,
    content: el('div', { class: 'form' },
      el('p', { class: 'muted' }, `Estoque atual: ${formatQty(product.stock_qty, product.unit)}`),
      typeChips.element,
      container),
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Salvar',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const body = current?.read();
          if (!body) return;
          const saved = await runBusy(button, () => api.post(`/products/${encodeURIComponent(product.id)}/movements`, body));
          if (!saved) return;
          invalidateCatalog();
          close();
          const extra = body.register_expense ? ` Despesa de ${formatCents(body.total_cost_cents)} lançada no caixa.` : '';
          toast(`${TYPES[body.type].verb}. Estoque: ${formatQty(saved.stock_qty, saved.unit)}.${extra}`, { type: 'success', duration: 5000 });
          if (saved.low_stock) toast(`Atenção: ${saved.name} está com estoque baixo.`, { type: 'error', duration: 6000 });
          onSaved?.(saved);
        },
      },
    ],
  });
}

/** Abre a movimentação. Sem `product`, pede primeiro para escolher o produto. */
export async function openStockForm({ product = null, isAdmin = false, onSaved, initialType } = {}) {
  if (product) {
    await openForProduct(product, { isAdmin, onSaved, initialType });
    return;
  }

  let products;
  try {
    products = await getProducts();
  } catch (error) {
    toast(error.message, { type: 'error' });
    return;
  }
  const content = products.length
    ? el('div', { class: 'chips chips-wrap', role: 'group', 'aria-label': 'Produto' },
      products.map((p) => el('button', {
        class: 'chip',
        type: 'button',
        onclick: () => { modal.close(); openForProduct(p, { isAdmin, onSaved, initialType }); },
      }, p.name, el('small', { class: 'chip-hint' }, formatQty(p.stock_qty, p.unit)))))
    : el('p', { class: 'muted' }, isAdmin ? 'Nenhum produto cadastrado. Cadastre em Mais → Produtos.' : 'Nenhum produto cadastrado. Peça ao administrador.');
  const modal = openModal({ title: 'Qual produto?', content, actions: [{ label: 'Fechar', variant: 'btn-outline' }] });
}

