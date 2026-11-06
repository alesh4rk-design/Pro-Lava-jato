// Financeiro (administrador do sistema): mensalidade de cada lava-jato, pagamentos, plano, cancelamento e cobrança por WhatsApp.
// O pagamento é registrado à mão: o sistema controla vencimento e acesso, mas não cobra sozinho.

import { session } from './app.js';
import { api } from './api.js';
import { config } from './config.js';
import { formatCents, formatDate, formatPhone, parseMoneyToCents, centsToInput, isValidISODate } from './format.js';
import { el, icon, field, chipGroup, toast, openModal, confirmDialog, stateView, runBusy, setFieldError } from './ui.js';
import { PAYMENT_METHODS, nextPaidUntil, stateBadge, dueLine, collectionMessage } from './cobranca.js';
import { whatsappUrl } from './whatsapp.js';

const $ = (id) => document.getElementById(id);
const list = $('bill-list');
const search = $('bill-search');
const FILTERS = [['ATENCAO', 'Atenção'], ['TODOS', 'Todos'], ['VENCIDA', 'Vencidas'], ['EM_ATRASO', 'Em atraso'], ['VENCENDO', 'Vencendo'], ['EM_DIA', 'Em dia'], ['TESTE', 'Teste'], ['CANCELADA', 'Canceladas'], ['ISENTA', 'Isentas']];
let filter = 'ATENCAO';
let query = '';
let data = { today: '', items: [], counts: {}, summary: { mrr_cents: 0, received_month_cents: 0 } };
let seq = 0;

/* Resumo e filtros ------------------------------------------------------------------------ */

function renderSummary() {
  const { summary, counts } = data;
  $('bill-summary').replaceChildren(
    el('div', { class: 'card' }, el('div', { class: 'stat-label' }, 'Recebido no mês'), el('div', { class: 'stat-value num' }, formatCents(summary.received_month_cents))),
    el('div', { class: 'card' }, el('div', { class: 'stat-label' }, 'Previsto por mês'), el('div', { class: 'stat-value num' }, formatCents(summary.mrr_cents))),
    el('div', { class: `card${counts.ATENCAO ? ' is-attention' : ''}` }, el('div', { class: 'stat-label' }, 'Precisam de atenção'), el('div', { class: 'stat-value num' }, String(counts.ATENCAO ?? 0))));
}

function renderChips() {
  $('bill-chips').replaceChildren(...FILTERS.map(([value, label]) => el('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(value === filter), 'data-state': value,
    onclick: () => { filter = value; load(); },
  }, `${label} (${data.counts[value] ?? 0})`)));
}

/* Cartão de cliente ------------------------------------------------------------------------ */

function card(t) {
  const badge = stateBadge(t.billing);
  const price = t.plan_price_cents > 0 ? `${formatCents(t.plan_price_cents)} por mês` : 'Valor da mensalidade não definido';
  const needsCollection = ['VENCENDO', 'EM_ATRASO', 'VENCIDA'].includes(t.billing.state);
  const subscribed = ['TESTE', 'ATIVA'].includes(t.subscription_status);
  return el('article', { class: `card tenant-card billing-card state-${t.billing.state}` },
    el('div', { class: 'tenant-card-head' }, el('h3', {}, t.business_name), el('span', { class: `badge ${badge.tone}` }, badge.label)),
    el('div', { class: 'tenant-meta' },
      t.owner_name ? el('span', {}, [t.owner_name, t.phone ? formatPhone(t.phone) : null].filter(Boolean).join(' · ')) : null,
      el('span', {}, t.subscription_status === 'ISENTA' ? 'Isento de mensalidade' : price),
      dueLine(t.billing) ? el('span', {}, dueLine(t.billing)) : null,
      t.status === 'BLOQUEADO' ? el('span', { class: 'text-danger' }, 'Acesso bloqueado manualmente') : null,
      t.subscription_cancel_reason ? el('span', { class: 'customer-notes' }, `Motivo do cancelamento: ${t.subscription_cancel_reason}`) : null),
    el('div', { class: 'billing-actions' },
      t.subscription_status === 'ISENTA' ? null : el('button', { class: 'btn btn-primary billing-main', type: 'button', onclick: () => openPayment(t) }, icon('check', 'icon icon-sm'), 'Registrar pagamento'),
      needsCollection ? el('button', { class: 'btn btn-success', type: 'button', onclick: () => openCollection(t) }, icon('message', 'icon icon-sm'), 'Cobrar') : null,
      el('button', { class: 'btn btn-outline', type: 'button', onclick: () => openHistory(t) }, 'Pagamentos'),
      el('button', { class: 'btn btn-outline', type: 'button', onclick: () => openPlan(t) }, icon('edit', 'icon icon-sm'), 'Plano'),
      subscribed ? el('button', { class: 'btn btn-outline btn-danger-text', type: 'button', onclick: () => openCancel(t) }, 'Cancelar assinatura') : null,
      t.subscription_status === 'CANCELADA' ? el('button', { class: 'btn btn-outline', type: 'button', onclick: () => reactivate(t) }, icon('unlock', 'icon icon-sm'), 'Reativar') : null));
}

/* Registrar pagamento --------------------------------------------------------------------- */

function openPayment(t) {
  let months = 1;
  let touched = false;
  const amount = el('input', { class: 'input', id: 'pay-amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0,00', maxlength: 16, 'aria-label': 'Valor recebido', value: centsToInput(t.plan_price_cents || undefined) });
  amount.addEventListener('input', () => { touched = true; });
  const preview = el('p', { class: 'hint', 'aria-live': 'polite' });
  const refresh = () => { preview.textContent = `Novo vencimento: ${formatDate(nextPaidUntil({ paidUntil: t.paid_until, today: data.today, months }))}`; };
  const monthChips = chipGroup({
    label: 'Meses pagos',
    options: [1, 3, 6, 12].map((n) => ({ value: n, label: n === 1 ? '1 mês' : `${n} meses` })),
    value: 1,
    onChange: (opt) => {
      months = opt.value;
      if (!touched && t.plan_price_cents) amount.value = centsToInput(t.plan_price_cents * months);
      refresh();
    },
  });
  const method = chipGroup({ label: 'Forma de pagamento', options: Object.entries(PAYMENT_METHODS).map(([value, label]) => ({ value, label })), value: 'PIX' });
  const paidOn = field({ id: 'pay-date', label: 'Data do pagamento', type: 'date', max: data.today, value: data.today });
  const note = field({ id: 'pay-note', label: 'Observação (opcional)', type: 'text', maxlength: 200, placeholder: 'Ex.: comprovante enviado por WhatsApp', autocomplete: 'off' });
  refresh();

  const form = el('form', { class: 'form', novalidate: true },
    el('div', { class: 'field' }, el('span', { class: 'stat-label' }, 'Meses pagos'), monthChips.element),
    el('div', { class: 'field' }, el('label', { for: 'pay-amount' }, 'Valor recebido'), el('div', { class: 'money-field' }, el('span', { class: 'money-prefix' }, 'R$'), amount), el('span', { class: 'field-error', id: 'pay-amount-error' })),
    preview,
    el('div', { class: 'field' }, el('span', { class: 'stat-label' }, 'Forma de pagamento'), method.element),
    paidOn,
    note);

  openModal({
    title: `Pagamento · ${t.business_name}`,
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Registrar',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const cents = parseMoneyToCents(amount.value);
          setFieldError(amount, cents ? null : 'Informe o valor recebido. Ex.: 149,90');
          const dateInput = form.querySelector('#pay-date');
          const dateOk = isValidISODate(dateInput.value) && dateInput.value <= data.today;
          setFieldError(dateInput, dateOk ? null : 'Data inválida ou futura.');
          if (!cents || !dateOk) return;
          const saved = await runBusy(button, () => api.post(`/system/billing/${encodeURIComponent(t.id)}/payments`, {
            amount_cents: cents, months, paid_on: dateInput.value, method: method.value, note: form.querySelector('#pay-note').value.trim(),
          }));
          if (!saved) return;
          close();
          toast(`Pagamento registrado. Pago até ${formatDate(saved.tenant.paid_until)}.`, { type: 'success' });
          load();
        },
      },
    ],
  });
  amount.focus();
}

/* Histórico e estorno --------------------------------------------------------------------- */

function openReverse(payment, onDone) {
  const reason = field({ id: 'rev-reason', label: 'Motivo (opcional)', type: 'text', maxlength: 200, placeholder: 'Ex.: Pix devolvido ao cliente', autocomplete: 'off' });
  openModal({
    title: 'Estornar pagamento?',
    content: el('div', { class: 'form' },
      el('p', {}, `${formatCents(payment.amount_cents)} de ${formatDate(payment.paid_on)}. O vencimento volta para o que era antes deste pagamento e o valor sai do total recebido.`),
      reason),
    actions: [
      { label: 'Voltar', variant: 'btn-outline' },
      {
        label: 'Estornar',
        variant: 'btn-danger',
        onClick: async (close, button) => {
          const done = await runBusy(button, () => api.post(`/system/payments/${encodeURIComponent(payment.id)}/reverse`, { reason: reason.querySelector('input').value.trim() }));
          if (!done) return;
          close();
          toast('Pagamento estornado.', { type: 'success' });
          onDone();
        },
      },
    ],
  });
}

async function openHistory(t) {
  let items;
  try {
    ({ items } = await api.get(`/system/billing/${encodeURIComponent(t.id)}/payments`));
  } catch (error) {
    toast(error.message, { type: 'error' });
    return;
  }
  const rows = items.map((p) => el('li', { class: `list-row payment-row${p.status === 'ESTORNADO' ? ' is-reversed' : ''}` },
    el('span', {},
      el('strong', {}, `${formatCents(p.amount_cents)} · ${p.months === 1 ? '1 mês' : `${p.months} meses`}`),
      el('small', { class: 'hint movement-meta' }, [formatDate(p.paid_on), PAYMENT_METHODS[p.method], p.note, p.status === 'ESTORNADO' ? `Estornado${p.reversed_reason ? `: ${p.reversed_reason}` : ''}` : `cobre até ${formatDate(p.period_end)}`].filter(Boolean).join(' · '))),
    p.status === 'ESTORNADO' ? el('span', { class: 'badge badge-danger' }, 'Estornado')
      : p.can_reverse ? el('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => { document.querySelector('dialog[open]')?.close(); openReverse(p, () => { load(); }); } }, 'Estornar') : null));
  openModal({
    title: `Pagamentos · ${t.business_name}`,
    content: items.length ? el('ul', { class: 'list' }, rows) : el('p', { class: 'muted' }, 'Nenhum pagamento registrado ainda.'),
    actions: [{ label: 'Fechar', variant: 'btn-outline' }],
  });
}

/* Plano ------------------------------------------------------------------------------------ */

function openPlan(t) {
  const price = el('input', { class: 'input', id: 'plan-price', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0,00', maxlength: 16, 'aria-label': 'Valor da mensalidade', value: centsToInput(t.plan_price_cents || undefined) });
  const until = field({ id: 'plan-until', label: 'Pago até (vencimento)', type: 'date', value: t.paid_until ?? '', min: '2020-01-01', hint: 'Use para dar mais prazo (ex.: uma semana de cortesia). Pagamentos registrados já calculam o vencimento sozinhos.' });
  const exempt = el('input', { type: 'checkbox', id: 'plan-exempt', checked: t.subscription_status === 'ISENTA' });
  const form = el('form', { class: 'form', novalidate: true },
    el('div', { class: 'field' }, el('label', { for: 'plan-price' }, 'Valor da mensalidade'), el('div', { class: 'money-field' }, el('span', { class: 'money-prefix' }, 'R$'), price), el('span', { class: 'field-error', id: 'plan-price-error' })),
    until,
    el('label', { class: 'switch', for: 'plan-exempt' }, 'Isento (cortesia, nunca vence)', exempt));
  openModal({
    title: `Plano · ${t.business_name}`,
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Salvar',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const raw = price.value.trim();
          const cents = raw ? parseMoneyToCents(raw) : 0;
          setFieldError(price, raw && !cents ? 'Valor inválido. Ex.: 149,90' : null);
          if (raw && !cents) return;
          const dateInput = form.querySelector('#plan-until');
          const body = {};
          if (cents !== t.plan_price_cents) body.plan_price_cents = cents;
          if (exempt.checked !== (t.subscription_status === 'ISENTA')) body.exempt = exempt.checked;
          if (dateInput.value && dateInput.value !== t.paid_until) {
            if (!isValidISODate(dateInput.value)) { setFieldError(dateInput, 'Data inválida.'); return; }
            body.paid_until = dateInput.value;
          }
          if (!Object.keys(body).length) { close(); return; }
          const saved = await runBusy(button, () => api.put(`/system/billing/${encodeURIComponent(t.id)}/plan`, body));
          if (!saved) return;
          close();
          toast('Plano atualizado.', { type: 'success' });
          load();
        },
      },
    ],
  });
}

/* Cancelar e reativar -------------------------------------------------------------------- */

function openCancel(t) {
  const reason = field({ id: 'cancel-reason', label: 'Motivo (opcional)', type: 'text', maxlength: 200, placeholder: 'Ex.: pediu para cancelar', autocomplete: 'off' });
  const blockNow = el('input', { type: 'checkbox', id: 'cancel-block' });
  openModal({
    title: `Cancelar assinatura · ${t.business_name}`,
    content: el('div', { class: 'form' },
      el('p', {}, t.paid_until ? `A assinatura deixa de renovar. O lava-jato continua usando o sistema até ${formatDate(t.paid_until)}, que já foi pago, e depois perde o acesso.` : 'A assinatura deixa de renovar.'),
      reason,
      el('label', { class: 'switch', for: 'cancel-block' }, 'Bloquear o acesso agora', blockNow),
      el('p', { class: 'hint' }, 'Os dados do lava-jato são mantidos. Dá para reativar depois.')),
    actions: [
      { label: 'Voltar', variant: 'btn-outline' },
      {
        label: 'Cancelar assinatura',
        variant: 'btn-danger',
        onClick: async (close, button) => {
          const done = await runBusy(button, () => api.post(`/system/billing/${encodeURIComponent(t.id)}/cancel`, { reason: reason.querySelector('input').value.trim(), block_now: blockNow.checked }));
          if (!done) return;
          close();
          toast(blockNow.checked ? 'Assinatura cancelada e acesso bloqueado.' : 'Assinatura cancelada.', { type: 'success' });
          load();
        },
      },
    ],
  });
}

async function reactivate(t) {
  const ok = await confirmDialog({
    title: 'Reativar assinatura?',
    message: t.billing.access ? `${t.business_name} volta a ter a assinatura ativa.` : `${t.business_name} volta a ter a assinatura ativa, mas o acesso só volta com um novo pagamento (a data paga já passou).`,
    confirmLabel: 'Reativar',
  });
  if (!ok) return;
  try {
    await api.post(`/system/billing/${encodeURIComponent(t.id)}/reactivate`, {});
    toast('Assinatura reativada.', { type: 'success' });
    load();
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

/* Cobrança por WhatsApp -------------------------------------------------------------------- */

function openCollection(t) {
  const text = el('textarea', { class: 'input', id: 'collect-text', rows: 6, maxlength: 1000, 'aria-label': 'Mensagem de cobrança' }, collectionMessage({ owner: t.owner_name, business: t.business_name, billing: t.billing, priceCents: t.plan_price_cents }));
  openModal({
    title: `Cobrar · ${t.business_name}`,
    content: el('div', { class: 'form' }, el('p', { class: 'muted' }, t.phone ? formatPhone(t.phone) : 'Sem telefone cadastrado'), el('div', { class: 'field' }, text, el('span', { class: 'hint' }, 'Confira o texto: o WhatsApp abre com ele pronto e você toca em enviar.'))),
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Abrir WhatsApp',
        variant: 'btn-success',
        onClick: (close) => {
          const url = whatsappUrl(t.phone, text.value.trim());
          if (!url) { toast('Este cliente não tem um telefone válido cadastrado.', { type: 'error' }); return; }
          window.open(url, '_blank', 'noopener,noreferrer');
          close();
        },
      },
    ],
  });
}

/* Carregar --------------------------------------------------------------------------------- */

async function load() {
  const mine = ++seq;
  renderChips();
  list.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'skeleton sk-line' })));
  try {
    const params = new URLSearchParams({ state: filter });
    if (query) params.set('q', query);
    const result = await api.get(`/system/billing?${params}`);
    if (mine !== seq) return;
    data = result;
    renderSummary();
    renderChips();
    list.replaceChildren(...(data.items.length ? data.items.map(card) : [stateView({
      title: filter === 'ATENCAO' ? 'Tudo em dia' : 'Nenhum cliente aqui',
      message: filter === 'ATENCAO' ? 'Nenhuma mensalidade vencida ou perto de vencer.' : 'Tente outro filtro ou outra busca.',
    })]));
  } catch (error) {
    if (mine !== seq) return;
    list.replaceChildren(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: load }));
  }
}

if (session) {
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query = search.value.trim(); load(); }, 300); });
  load();
}
