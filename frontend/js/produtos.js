// Produtos e insumos: estoque, alerta de estoque baixo, histórico e cadastro (ADMIN).

import { session } from './app.js';
import { api } from './api.js';
import { config } from './config.js';
import { formatQty, formatUnitCost, formatCents, formatDateTime, UNITS } from './format.js';
import { el, icon, field, chipGroup, toast, openModal, stateView, runBusy, validateFields } from './ui.js';
import { qtyField, sectionLabel } from './entry-form.js';
import { getCategories, invalidateCatalog } from './catalog.js';
import { openStockForm } from './estoque.js';

const MOVEMENT_LABELS = { ENTRADA: 'Compra', SAIDA: 'Consumo', AJUSTE: 'Ajuste' };
const list = document.getElementById('product-list');
const isAdmin = session?.user.role === 'ADMIN';
let lowOnly = new URLSearchParams(location.search).get('filtro') === 'baixo';

async function openProductForm(product = null) {
  let categories = [];
  try {
    categories = await getCategories('PRODUTO');
  } catch {
    // categoria é opcional
  }
  const minHolder = el('div', {});
  let minQty;
  // O mínimo segue a unidade do produto; na edição aparece na menor unidade (valor exato gravado).
  const renderMin = (u) => {
    minQty = qtyField({ id: 'p-min', label: 'Estoque mínimo (alerta)', unit: u, allowZero: true, initialBig: !product, hint: 'Abaixo disso o produto aparece como "estoque baixo".' });
    if (product) minQty.input.value = String(product.min_stock_qty);
    minHolder.replaceChildren(minQty.element);
  };
  const unit = chipGroup({
    label: 'Unidade',
    options: Object.entries(UNITS).map(([value, info]) => ({ value, label: info.label })),
    value: product?.unit ?? 'ML',
    onChange: (opt) => renderMin(opt.value),
  });
  const category = chipGroup({
    label: 'Categoria',
    options: [{ value: null, label: 'Sem categoria' }, ...categories.map((c) => ({ value: c.id, label: c.name }))],
    value: product?.category_id ?? null,
  });
  renderMin(product?.unit ?? 'ML');
  const active = el('input', { type: 'checkbox', id: 'p-active', checked: product ? product.active : true });

  const form = el('form', { class: 'form', novalidate: true },
    field({ id: 'p-name', label: 'Nome', type: 'text', maxlength: 60, value: product?.name ?? '', autocomplete: 'off' }),
    product
      ? el('p', { class: 'hint' }, `Unidade: ${UNITS[product.unit].label} (não pode ser alterada).`)
      : el('div', { class: 'field' }, sectionLabel('Unidade'), unit.element),
    minHolder,
    categories.length ? el('div', { class: 'field' }, sectionLabel('Categoria'), category.element) : null,
    product ? el('label', { class: 'switch', for: 'p-active' }, 'Produto ativo', active) : null,
  );

  openModal({
    title: product ? 'Editar produto' : 'Novo produto',
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Salvar',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const name = form.querySelector('#p-name');
          if (!validateFields([[name, (v) => (v.trim() ? null : 'Informe o nome.')]])) return;
          const min = minQty.read();
          if (min === null) return;
          const body = { name: name.value.trim(), min_stock_qty: min, category_id: category.value ?? null };
          if (product) body.active = active.checked;
          else body.unit = unit.value;
          const saved = await runBusy(button, () => (product
            ? api.put(`/products/${encodeURIComponent(product.id)}`, body)
            : api.post('/products', body)));
          if (!saved) return;
          invalidateCatalog();
          close();
          toast(product ? 'Produto atualizado.' : 'Produto cadastrado. Registre a primeira compra para dar entrada no estoque.', { type: 'success', duration: 5000 });
          load();
        },
      },
    ],
  });
}

async function openDetail(id) {
  let product;
  try {
    product = await api.get(`/products/${encodeURIComponent(id)}`);
  } catch (error) {
    toast(error.message, { type: 'error' });
    return;
  }
  const movements = product.movements.length
    ? el('ul', { class: 'list' }, product.movements.map((m) => el('li', { class: 'list-row' },
      el('span', {},
        el('strong', {}, `${MOVEMENT_LABELS[m.type]} ${m.qty > 0 ? '+' : ''}${formatQty(m.qty, product.unit)}`),
        el('small', { class: 'hint movement-meta' }, `${formatDateTime(m.created_at, config.TIMEZONE)} · ${m.user_name}${m.reason ? ` · ${m.reason}` : ''}`)),
      isAdmin && m.total_cost_cents ? el('span', { class: 'muted num' }, formatCents(Math.abs(m.total_cost_cents))) : null)))
    : el('p', { class: 'muted' }, 'Nenhuma movimentação ainda.');

  const refresh = () => load();
  const actions = [
    { label: 'Movimentar', variant: 'btn-primary', onClick: (close) => { close(); openStockForm({ product, isAdmin, onSaved: refresh }); } },
  ];
  if (isAdmin) actions.unshift({ label: 'Editar', variant: 'btn-outline', onClick: (close) => { close(); openProductForm(product); } });

  openModal({
    title: product.name,
    content: el('div', { class: 'section' },
      el('div', { class: 'list' },
        el('div', { class: 'list-row' }, el('span', { class: 'muted' }, 'Estoque'), el('strong', { class: product.low_stock ? 'text-danger' : '' }, formatQty(product.stock_qty, product.unit))),
        el('div', { class: 'list-row' }, el('span', { class: 'muted' }, 'Mínimo'), el('strong', {}, formatQty(product.min_stock_qty, product.unit))),
        isAdmin ? el('div', { class: 'list-row' }, el('span', { class: 'muted' }, 'Custo médio'), el('strong', {}, formatUnitCost(product.avg_cost_micro, product.unit))) : null,
      ),
      el('h3', { class: 'section-title' }, 'Últimas movimentações'),
      movements,
    ),
    actions,
  });
}

function productCard(p) {
  return el('button', { class: 'card tenant-card user-card', type: 'button', onclick: () => openDetail(p.id) },
    el('div', { class: 'tenant-card-head' },
      el('h3', {}, p.name),
      !p.active ? el('span', { class: 'badge' }, 'Inativo')
        : p.low_stock ? el('span', { class: 'badge badge-danger' }, p.stock_qty <= 0 ? 'Sem estoque' : 'Estoque baixo') : null,
    ),
    el('div', { class: 'tenant-meta' },
      el('span', {}, `Estoque: ${formatQty(p.stock_qty, p.unit)} · mínimo ${formatQty(p.min_stock_qty, p.unit)}`),
      isAdmin && p.avg_cost_micro ? el('span', {}, `Custo médio: ${formatUnitCost(p.avg_cost_micro, p.unit)}`) : null,
    ),
    el('div', { class: 'tenant-actions' },
      p.category_name ? el('span', { class: 'badge badge-primary' }, p.category_name) : null,
      el('span', { class: 'chevron' }, icon('chevron-right', 'icon icon-sm'))),
  );
}

async function load() {
  list.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'skeleton sk-line' })));
  const params = new URLSearchParams();
  if (lowOnly) params.set('low_stock', '1');
  if (isAdmin) params.set('include_inactive', '1');
  try {
    const { items } = await api.get(`/products?${params}`);
    if (items.length) list.replaceChildren(...items.map(productCard));
    else list.replaceChildren(stateView(lowOnly
      ? { title: 'Nenhum produto com estoque baixo', message: 'Tudo em ordem por aqui.' }
      : { title: 'Nenhum produto', message: isAdmin ? 'Cadastre os produtos que você usa (shampoo, cera, panos...).' : 'O administrador ainda não cadastrou produtos.' }));
  } catch (error) {
    list.replaceChildren(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: load }));
  }
}

if (session) {
  const chips = document.querySelectorAll('#filter-chips .chip');
  chips.forEach((chip) => {
    chip.setAttribute('aria-pressed', String((chip.dataset.filter === 'low') === lowOnly));
    chip.addEventListener('click', () => {
      lowOnly = chip.dataset.filter === 'low';
      chips.forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      load();
    });
  });
  document.getElementById('new-product').addEventListener('click', () => openProductForm());
  load();
}
