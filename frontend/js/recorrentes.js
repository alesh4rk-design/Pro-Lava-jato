// Despesas recorrentes (somente ADMIN): cadastrar, editar, pausar e retomar. O Worker lança a despesa em cada vencimento.

import { session } from './app.js';
import { api } from './api.js';
import { config } from './config.js';
import { formatCents, formatDate, parseMoneyToCents, centsToInput, isValidISODate, todayISO } from './format.js';
import { el, icon, field, chipGroup, toast, openModal, stateView, runBusy, setFieldError, editChip } from './ui.js';
import { PAYMENT_LABELS, EXPENSE_TYPE_LABELS, sectionLabel } from './entry-form.js';
import { getCategories } from './catalog.js';
import { newCategoryButton } from './categoria-rapida.js';
import { FREQUENCY_LABELS, WEEKDAYS, scheduleText } from './recorrentes-text.js';

const list = document.getElementById('recurring-list');

async function openForm(rec = null) {
  let categories;
  try {
    categories = await getCategories('DESPESA');
  } catch (error) {
    toast(error.message, { type: 'error' });
    return;
  }
  const today = todayISO(config.TIMEZONE);

  const amount = el('input', { class: 'input', id: 'r-amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0,00', maxlength: 16, value: centsToInput(rec?.amount_cents), 'aria-label': 'Valor' });
  const amountField = el('div', { class: 'field' },
    el('label', { for: 'r-amount' }, 'Valor de cada lançamento'),
    el('div', { class: 'money-field' }, el('span', { class: 'money-prefix' }, 'R$'), amount),
    el('span', { class: 'field-error', id: 'r-amount-error' }));

  const description = field({ id: 'r-description', label: 'Descrição', type: 'text', maxlength: 120, value: rec?.description ?? '', placeholder: 'Ex.: Aluguel do galpão', autocomplete: 'off' });
  const category = chipGroup({
    label: 'Categoria',
    options: categories.map((c) => ({ value: c.id, label: c.name, type: c.default_expense_type })),
    value: rec?.category_id ?? null,
  });
  const categoryError = el('span', { class: 'field-error' });
  const addCategory = newCategoryButton((created, all) => {
    category.setOptions(all.map((c) => ({ value: c.id, label: c.name, type: c.default_expense_type })), created.id);
    categoryError.textContent = '';
  });
  const payment = chipGroup({ label: 'Forma de pagamento', options: Object.entries(PAYMENT_LABELS).map(([value, label]) => ({ value, label })), value: rec?.payment_method ?? 'PIX' });
  const type = chipGroup({ label: 'Tipo', options: Object.entries(EXPENSE_TYPE_LABELS).map(([value, label]) => ({ value, label })), value: rec?.type ?? 'DESPESA_FIXA' });

  const weekday = chipGroup({ label: 'Dia da semana', options: WEEKDAYS.map((label, value) => ({ value, label: label.slice(0, 3) })), value: rec?.weekday ?? new Date().getDay() });
  const monthDay = field({ id: 'r-monthday', label: 'Dia do mês', type: 'number', inputmode: 'numeric', min: 1, max: 31, value: rec?.month_day ?? Number(today.slice(8)), hint: 'Use 31 para "último dia do mês" (vale também em meses curtos).' });
  const weekdayBox = el('div', { class: 'field' }, sectionLabel('Dia da semana'), weekday.element);
  const frequency = chipGroup({
    label: 'Frequência',
    options: Object.entries(FREQUENCY_LABELS).map(([value, label]) => ({ value, label })),
    value: rec?.frequency ?? 'MENSAL',
    onChange: () => sync(),
  });
  const sync = () => { weekdayBox.hidden = frequency.value !== 'SEMANAL'; monthDay.hidden = frequency.value !== 'MENSAL'; };

  const start = field({ id: 'r-start', label: 'Começa em', type: 'date', min: today, value: rec?.start_date ?? today });
  const end = field({ id: 'r-end', label: 'Termina em (opcional)', type: 'date', min: today, value: rec?.end_date ?? '', hint: 'Deixe em branco para repetir sem data final.' });
  const startInput = start.querySelector('input');
  if (rec) { startInput.disabled = true; start.append(el('span', { class: 'hint' }, 'O início não pode ser alterado depois de criada.')); }

  const form = el('form', { class: 'form', novalidate: true },
    amountField,
    description,
    el('div', { class: 'field' }, sectionLabel('Categoria'), category.element, addCategory, categoryError),
    el('div', { class: 'field' }, sectionLabel('Repete'), frequency.element),
    weekdayBox,
    monthDay,
    start,
    end,
    el('div', { class: 'field' }, sectionLabel('Forma de pagamento'), payment.element),
    el('div', { class: 'field' }, sectionLabel('Tipo'), type.element),
    rec ? el('p', { class: 'hint' }, 'Mudanças valem para os próximos lançamentos. O que já foi lançado não muda.') : null,
  );
  sync();

  openModal({
    title: rec ? 'Editar recorrente' : 'Nova despesa recorrente',
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Salvar',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const cents = parseMoneyToCents(amount.value);
          setFieldError(amount, cents ? null : 'Informe um valor maior que zero. Ex.: 2.500,00');
          categoryError.textContent = category.value ? '' : 'Escolha a categoria.';
          const day = Number(form.querySelector('#r-monthday').value);
          const dayOk = frequency.value !== 'MENSAL' || (Number.isInteger(day) && day >= 1 && day <= 31);
          setFieldError(form.querySelector('#r-monthday'), dayOk ? null : 'Escolha de 1 a 31.');
          const startValue = startInput.value;
          const startOk = Boolean(rec) || (isValidISODate(startValue) && startValue >= today);
          setFieldError(startInput, startOk ? null : 'Escolha hoje ou uma data futura.');
          const endInput = end.querySelector('input');
          const endOk = !endInput.value || (isValidISODate(endInput.value) && endInput.value >= (rec?.start_date ?? startValue));
          setFieldError(endInput, endOk ? null : 'A data final não pode ser antes do início.');
          if (!cents || !category.value || !dayOk || !startOk || !endOk) return;

          const body = {
            category_id: category.value,
            description: description.querySelector('input').value.trim(),
            amount_cents: cents,
            payment_method: payment.value,
            type: type.value,
            frequency: frequency.value,
            end_date: endInput.value || null,
          };
          if (frequency.value === 'SEMANAL') body.weekday = weekday.value;
          if (frequency.value === 'MENSAL') body.month_day = day;
          if (!rec) body.start_date = startValue;

          const saved = await runBusy(button, () => (rec
            ? api.put(`/recurring-expenses/${encodeURIComponent(rec.id)}`, body)
            : api.post('/recurring-expenses', body)));
          if (!saved) return;
          close();
          toast(rec ? 'Despesa recorrente atualizada.' : 'Despesa recorrente criada.', { type: 'success' });
          load();
        },
      },
    ],
  });
}

async function setActive(rec, active, button) {
  const saved = await runBusy(button, () => api.put(`/recurring-expenses/${encodeURIComponent(rec.id)}`, { active }));
  if (!saved) return;
  toast(active ? 'Retomada. Os dias parados não são lançados.' : 'Pausada. Nada será lançado até retomar.', { type: 'success' });
  load();
}

function card(rec) {
  const pause = el('button', { class: 'btn btn-outline', type: 'button', onclick: (e) => { e.stopPropagation(); setActive(rec, !rec.active, e.currentTarget); } },
    icon(rec.active ? 'ban' : 'unlock', 'icon icon-sm'), rec.active ? 'Pausar' : 'Retomar');
  return el('article', { class: 'card tenant-card recurring-card' },
    el('button', { class: 'recurring-main', type: 'button', onclick: () => openForm(rec), 'aria-label': `Editar ${rec.description || rec.category_name}` },
      el('div', { class: 'tenant-card-head' },
        el('h3', {}, rec.description || rec.category_name),
        el('strong', { class: 'num text-danger' }, formatCents(rec.amount_cents))),
      el('div', { class: 'tenant-meta' },
        el('span', {}, `${FREQUENCY_LABELS[rec.frequency]} · ${scheduleText(rec)}`),
        el('span', {}, rec.category_name),
        rec.active && rec.next_date ? el('span', {}, `Próximo lançamento: ${formatDate(rec.next_date)}`) : null,
        rec.end_date ? el('span', {}, `Termina em ${formatDate(rec.end_date)}`) : null),
      el('div', { class: 'tenant-actions' },
        el('span', { class: `badge ${rec.active ? 'badge-success' : 'badge'}` }, rec.active ? 'Ativa' : 'Pausada'),
        editChip())),
    el('div', { class: 'tenant-actions' }, pause));
}

async function load() {
  list.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'skeleton sk-line' })));
  try {
    const { items } = await api.get('/recurring-expenses');
    list.replaceChildren(...(items.length ? items.map(card) : [stateView({
      title: 'Nenhuma despesa recorrente',
      message: 'Cadastre o aluguel, a internet ou a diarista uma vez e o sistema lança sozinho a cada vencimento.',
    })]));
  } catch (error) {
    list.replaceChildren(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: load }));
  }
}

if (session) {
  document.getElementById('new-recurring').addEventListener('click', () => openForm());
  load();
}
