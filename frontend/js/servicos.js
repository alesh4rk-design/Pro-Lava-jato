// Serviços: preço e composição estimada do custo (ADMIN). Operador vê só nomes e preços.

import { session } from './app.js';
import { api } from './api.js';
import { formatCents, formatBasisPoints, parseMoneyToCents, centsToInput, UNITS } from './format.js';
import { el, icon, field, toast, openModal, stateView, runBusy, validateFields, setFieldError } from './ui.js';
import { sectionLabel } from './entry-form.js';
import { invalidateCatalog } from './catalog.js';

const list = document.getElementById('service-list');
const isAdmin = session?.user.role === 'ADMIN';

function moneyField(id, label, cents) {
  const input = el('input', { class: 'input', id, type: 'text', inputmode: 'decimal', placeholder: '0,00', maxlength: 16, autocomplete: 'off', value: centsToInput(cents) });
  return {
    input,
    element: el('div', { class: 'field' }, el('label', { for: id }, label),
      el('div', { class: 'money-field' }, el('span', { class: 'money-prefix' }, 'R$'), input),
      el('span', { class: 'field-error', id: `${id}-error` })),
  };
}

const marginText = (price, cost) => {
  const margin = price - cost;
  const bp = price ? Math.round((margin * 10_000) / price) : null;
  return `Custo estimado ${formatCents(cost)} · margem ${formatCents(margin)} (${formatBasisPoints(bp)})`;
};

/* Editor de composição -------------------------------------------------------------- */

function costEditor(initial, products, onChange) {
  const rows = el('div', { class: 'cost-rows' });
  const byId = new Map(products.map((p) => [p.id, p]));

  function rowCost(row) {
    if (row.kind === 'product') {
      const p = byId.get(Number(row.select.value));
      const qty = Number.parseInt(row.qty.value, 10);
      return p && qty > 0 ? Math.round((qty * p.avg_cost_micro) / 10_000) : 0;
    }
    return parseMoneyToCents(row.money.value) ?? 0;
  }

  const state = [];
  const notify = () => onChange(state.reduce((sum, r) => sum + rowCost(r), 0));

  function addRow(item = {}) {
    const kind = item.product_id || item.kind === 'product' ? 'product' : 'fixed';
    const row = { kind };
    const remove = el('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Remover item' }, icon('close', 'icon icon-sm'));
    let body;
    if (kind === 'product') {
      row.select = el('select', { class: 'input', 'aria-label': 'Produto' },
        products.map((p) => el('option', { value: String(p.id), selected: p.id === item.product_id }, p.name)));
      row.qty = el('input', { class: 'input', type: 'text', inputmode: 'numeric', placeholder: 'Qtd.', maxlength: 9, value: item.qty ? String(item.qty) : '', 'aria-label': 'Quantidade' });
      row.unit = el('span', { class: 'qty-unit' });
      const syncUnit = () => { row.unit.textContent = UNITS[byId.get(Number(row.select.value))?.unit]?.small ?? ''; };
      row.select.addEventListener('change', () => { syncUnit(); notify(); });
      syncUnit();
      body = el('div', { class: 'cost-row' }, row.select, el('div', { class: 'qty-row' }, row.qty, row.unit), remove);
    } else {
      row.description = el('input', { class: 'input', type: 'text', placeholder: 'Ex.: Água, Energia', maxlength: 60, value: item.description ?? '', 'aria-label': 'Descrição do custo' });
      row.money = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: 'R$ 0,00', maxlength: 16, value: centsToInput(item.fixed_cost_cents), 'aria-label': 'Valor' });
      body = el('div', { class: 'cost-row' }, row.description, row.money, remove);
    }
    body.addEventListener('input', notify);
    remove.addEventListener('click', () => { state.splice(state.indexOf(row), 1); body.remove(); notify(); });
    row.element = body;
    state.push(row);
    rows.append(body);
    notify();
  }

  initial.forEach(addRow);
  const element = el('div', { class: 'field' },
    sectionLabel('Composição do custo (por serviço)'),
    rows,
    el('div', { class: 'cost-add' },
      products.length ? el('button', { class: 'btn btn-outline', type: 'button', onclick: () => addRow({ kind: 'product' }) }, icon('droplet', 'icon icon-sm'), 'Produto') : null,
      el('button', { class: 'btn btn-outline', type: 'button', onclick: () => addRow({}) }, icon('plus', 'icon icon-sm'), 'Custo rateado')),
    el('span', { class: 'hint' }, 'Produto: quanto se usa por serviço (ex.: 100 ml de shampoo). Rateado: valor estimado por serviço (água, energia).'),
  );

  return {
    element,
    /** Itens para a API, ou null se algum estiver incompleto. */
    read() {
      const items = [];
      for (const row of state) {
        if (row.kind === 'product') {
          const qty = Number(row.qty.value);
          const valid = /^\d{1,9}$/.test(row.qty.value.trim()) && qty > 0;
          row.qty.setAttribute('aria-invalid', String(!valid));
          if (!valid) { row.qty.focus(); return null; }
          items.push({ product_id: Number(row.select.value), qty });
        } else {
          const cents = parseMoneyToCents(row.money.value);
          const desc = row.description.value.trim();
          row.money.setAttribute('aria-invalid', String(!cents));
          row.description.setAttribute('aria-invalid', String(!desc));
          if (!cents || !desc) { (desc ? row.money : row.description).focus(); return null; }
          items.push({ description: desc, fixed_cost_cents: cents });
        }
      }
      return items;
    },
  };
}

/* Formulário do serviço -------------------------------------------------------------- */

async function openServiceForm(id = null) {
  let service = null;
  let products = [];
  try {
    [service, { items: products }] = await Promise.all([
      id ? api.get(`/services/${encodeURIComponent(id)}`) : null,
      api.get('/products'),
    ]);
  } catch (error) {
    toast(error.message, { type: 'error' });
    return;
  }

  const price = moneyField('s-price', 'Preço', service?.price_cents);
  const summary = el('p', { class: 'cost-summary' });
  const updateSummary = (cost) => {
    const cents = parseMoneyToCents(price.input.value) ?? 0;
    summary.textContent = `${marginText(cents, cost)} — estimativa`;
  };
  let currentCost = 0;
  const editor = costEditor(service?.costs ?? [], products, (cost) => { currentCost = cost; updateSummary(cost); });
  price.input.addEventListener('input', () => updateSummary(currentCost));
  const active = el('input', { type: 'checkbox', id: 's-active', checked: service ? service.active : true });

  const form = el('form', { class: 'form', novalidate: true },
    field({ id: 's-name', label: 'Nome', type: 'text', maxlength: 60, value: service?.name ?? '', autocomplete: 'off' }),
    price.element,
    service ? el('label', { class: 'switch', for: 's-active' }, 'Serviço ativo', active) : null,
    editor.element,
    summary,
  );
  updateSummary(currentCost);

  openModal({
    title: service ? 'Editar serviço' : 'Novo serviço',
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Salvar',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const name = form.querySelector('#s-name');
          const cents = parseMoneyToCents(price.input.value);
          const valid = validateFields([[name, (v) => (v.trim() ? null : 'Informe o nome.')]]);
          setFieldError(price.input, cents ? null : 'Informe o preço.');
          const items = editor.read();
          if (!valid || !cents || items === null) {
            if (items === null) toast('Complete ou remova os itens de custo destacados.', { type: 'error' });
            return;
          }

          const saved = await runBusy(button, async () => {
            const body = { name: name.value.trim(), price_cents: cents };
            if (service) body.active = active.checked;
            const result = service
              ? await api.put(`/services/${encodeURIComponent(service.id)}`, body)
              : await api.post('/services', body);
            return api.put(`/services/${encodeURIComponent(result.id)}/costs`, { items });
          });
          if (!saved) return;
          invalidateCatalog();
          close();
          toast(`${saved.name}: ${marginText(saved.price_cents, saved.estimated_cost_cents)}.`, { type: 'success', duration: 5000 });
          load();
        },
      },
    ],
  });
}

/* Lista ------------------------------------------------------------------------------- */

function serviceCard(s) {
  const content = [
    el('div', { class: 'tenant-card-head' },
      el('h3', {}, s.name),
      el('strong', { class: 'num' }, formatCents(s.price_cents))),
    isAdmin
      ? el('div', { class: 'tenant-meta' },
        s.has_cost_composition
          ? el('span', {}, marginText(s.price_cents, s.estimated_cost_cents))
          : el('span', {}, 'Sem composição de custo cadastrada'))
      : null,
    isAdmin
      ? el('div', { class: 'tenant-actions' },
        s.active ? (s.has_cost_composition ? el('span', { class: 'badge badge-warning' }, 'Estimativa') : null) : el('span', { class: 'badge' }, 'Inativo'),
        el('span', { class: 'chevron' }, icon('chevron-right', 'icon icon-sm')))
      : null,
  ];
  return isAdmin
    ? el('button', { class: 'card tenant-card user-card', type: 'button', onclick: () => openServiceForm(s.id) }, content)
    : el('div', { class: 'card tenant-card' }, content);
}

async function load() {
  list.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'skeleton sk-line' })));
  try {
    const { items } = await api.get(`/services${isAdmin ? '?include_inactive=1' : ''}`);
    list.replaceChildren(...(items.length ? items.map(serviceCard)
      : [stateView({ title: 'Nenhum serviço', message: isAdmin ? 'Cadastre seus serviços e preços (ex.: Lavagem completa, R$ 70,00).' : 'O administrador ainda não cadastrou serviços.' })]));
  } catch (error) {
    list.replaceChildren(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: load }));
  }
}

if (session) {
  document.getElementById('new-service').addEventListener('click', () => openServiceForm());
  load();
}
