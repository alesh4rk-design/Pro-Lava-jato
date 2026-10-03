// Formulário de receita (novo lançamento e edição).

import { api } from './api.js';
import { formatCents, centsToInput } from './format.js';
import { el, chipGroup, openModal, toast, runBusy, setFieldError } from './ui.js';
import { getServices } from './catalog.js';
import { commonFields, sectionLabel, diff } from './entry-form.js';

/** Abre o formulário. Com `entry`, edita (somente ADMIN; o servidor confere). */
export async function openRevenueForm({ entry = null, onSaved } = {}) {
  let services = [];
  try {
    services = await getServices();
  } catch (error) {
    toast(error.message, { type: 'error' });
    return;
  }

  const common = commonFields('revenue', entry);
  let lastAutoAmount = null;

  // Escolher o serviço preenche o valor com o preço, sem sobrescrever um valor digitado.
  const service = chipGroup({
    label: 'Serviço',
    options: [...services.map((s) => ({ value: s.id, label: s.name, hint: formatCents(s.price_cents), price: s.price_cents })), { value: null, label: 'Outro' }],
    value: entry ? entry.service_id : undefined, // nenhum selecionado em lançamento novo
    onChange: (opt) => {
      if (opt.price && (!common.amount.value || common.amount.value === lastAutoAmount)) {
        common.amount.value = centsToInput(opt.price);
        lastAutoAmount = common.amount.value;
      }
      if (opt.value === null) {
        common.more.open = true;
        common.descriptionInput.focus();
      }
    },
  });

  const form = el('form', { class: 'form', novalidate: true },
    el('div', { class: 'field' },
      sectionLabel('Serviço'),
      services.length
        ? service.element
        : el('p', { class: 'hint' }, 'Nenhum serviço cadastrado ainda. Descreva a receita em "Mais opções".'),
    ),
    common.amountField,
    common.paymentField,
    common.more,
  );
  if (!services.length) common.more.open = true;

  openModal({
    title: entry ? 'Editar receita' : 'Nova receita',
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: entry ? 'Salvar' : 'Registrar',
        variant: 'btn-success',
        onClick: async (close, button) => {
          const body = common.read();
          if (!body) return;
          body.service_id = service.value ?? null;
          if (body.service_id === null && !body.description) {
            common.more.open = true;
            setFieldError(common.descriptionInput, 'Escolha um serviço ou descreva a receita.');
            common.descriptionInput.focus();
            return;
          }
          setFieldError(common.descriptionInput, null);

          const saved = await runBusy(button, () => (entry
            ? api.put(`/revenues/${encodeURIComponent(entry.id)}`, diff(entry, body))
            : api.post('/revenues', body)));
          if (!saved) return;
          common.rememberPayment();
          close();
          toast(`Receita de ${formatCents(saved.amount_cents)} ${entry ? 'atualizada' : 'registrada'}.`, { type: 'success' });
          onSaved?.(saved);
        },
      },
    ],
  });
  if (!entry) common.amount.focus();
}
