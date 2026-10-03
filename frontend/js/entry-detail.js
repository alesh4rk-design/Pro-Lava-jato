// Detalhe de um lançamento (receita ou despesa), com editar e cancelar para ADMIN.

import { api } from './api.js';
import { config } from './config.js';
import { formatCents, formatDate, formatDateTime } from './format.js';
import { el, openModal, toast, runBusy } from './ui.js';
import { PAYMENT_LABELS, EXPENSE_TYPE_LABELS } from './entry-form.js';
import { openRevenueForm } from './receitas.js';
import { openExpenseForm } from './despesas.js';

const KINDS = {
  IN: { path: 'revenues', title: 'Receita', open: openRevenueForm },
  OUT: { path: 'expenses', title: 'Despesa', open: openExpenseForm },
};

const row = (label, value) => (value
  ? el('div', { class: 'list-row' }, el('span', { class: 'muted' }, label), el('strong', { class: 'text-right' }, value))
  : null);

function openCancel(kind, entry, onChanged) {
  const reason = el('textarea', { class: 'input', id: 'cancel-reason', maxlength: 200, placeholder: 'Ex.: lançado em dobro' });
  openModal({
    title: `Cancelar ${KINDS[kind].title.toLowerCase()}?`,
    content: el('div', { class: 'form' },
      el('p', {}, `${formatCents(entry.amount_cents)} em ${formatDate(entry.date)}. O lançamento fica no histórico como cancelado e deixa de contar nos totais.`),
      el('div', { class: 'field' }, el('label', { for: 'cancel-reason' }, 'Motivo (opcional)'), reason),
    ),
    actions: [
      { label: 'Voltar', variant: 'btn-outline' },
      {
        label: 'Cancelar lançamento',
        variant: 'btn-danger',
        onClick: async (close, button) => {
          const done = await runBusy(button, () => api.del(`/${KINDS[kind].path}/${encodeURIComponent(entry.id)}`, { reason: reason.value.trim() }));
          if (!done) return;
          close();
          toast('Lançamento cancelado.', { type: 'success' });
          onChanged();
        },
      },
    ],
  });
}

export async function openEntryDetail(kind, id, { isAdmin, onChanged }) {
  let entry;
  try {
    entry = await api.get(`/${KINDS[kind].path}/${encodeURIComponent(id)}`);
  } catch (error) {
    toast(error.message, { type: 'error' });
    return;
  }

  const active = entry.status === 'ATIVO';
  const content = el('div', { class: 'section' },
    el('div', { class: `stat-value num ${kind === 'IN' ? 'text-success' : 'text-danger'}` },
      `${kind === 'IN' ? '+' : '−'} ${formatCents(entry.amount_cents)}`),
    active ? null : el('span', { class: 'badge badge-danger' }, 'Cancelado'),
    el('div', { class: 'list' },
      row('Data', formatDate(entry.date)),
      row(kind === 'IN' ? 'Serviço' : 'Categoria', entry.service_name ?? entry.category_name),
      row('Tipo', EXPENSE_TYPE_LABELS[entry.type]),
      row('Pagamento', PAYMENT_LABELS[entry.payment_method]),
      row('Descrição', entry.description),
      row('Observação', entry.notes),
      row('Custo estimado', entry.service_cost_snapshot_cents ? formatCents(entry.service_cost_snapshot_cents) : null),
      row('Lançado por', entry.user_name),
      row('Registrado em', formatDateTime(entry.created_at, config.TIMEZONE)),
      active ? null : row('Cancelado por', entry.cancelled_by_name),
      active ? null : row('Cancelado em', formatDateTime(entry.cancelled_at, config.TIMEZONE)),
      active ? null : row('Motivo', entry.cancel_reason),
    ),
  );

  const actions = isAdmin && active
    ? [
      { label: 'Cancelar', variant: 'btn-outline', onClick: (close) => { close(); openCancel(kind, entry, onChanged); } },
      { label: 'Editar', variant: 'btn-primary', onClick: (close) => { close(); KINDS[kind].open({ entry, onSaved: onChanged }); } },
    ]
    : [{ label: 'Fechar', variant: 'btn-outline' }];

  openModal({ title: KINDS[kind].title, content, actions });
}
