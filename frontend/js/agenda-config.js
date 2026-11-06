// Configuração do agendamento online (ADMIN): liga o link, define horários, vagas e avisos.

import { session } from './app.js';
import { api } from './api.js';
import { el, field, toast, runBusy, stateView, confirmDialog } from './ui.js';
import { bookingLink, inviteMessage, WEEKDAY_NAMES } from './agenda-text.js';

const root = document.getElementById('config');
const ORDER = [1, 2, 3, 4, 5, 6, 0];

function hoursRow(day, range) {
  const open = el('input', { type: 'checkbox', id: `h-open-${day}`, checked: Boolean(range) });
  const from = el('input', { class: 'input', type: 'time', value: range?.[0] ?? '08:00', 'aria-label': `${WEEKDAY_NAMES[day]}: abre` });
  const to = el('input', { class: 'input', type: 'time', value: range?.[1] ?? '18:00', 'aria-label': `${WEEKDAY_NAMES[day]}: fecha` });
  const sync = () => { from.disabled = !open.checked; to.disabled = !open.checked; };
  open.addEventListener('change', sync);
  sync();
  return { day, open, from, to, node: el('div', { class: 'hours-row' }, el('label', {}, open, ` ${WEEKDAY_NAMES[day].slice(0, 3)}`), from, to) };
}

function render(s) {
  const link = bookingLink(s.code, location.href);
  const enabled = el('input', { type: 'checkbox', id: 'c-enabled', checked: s.enabled });
  const auto = el('input', { type: 'checkbox', id: 'c-auto', checked: s.auto_confirm });
  const rows = ORDER.map((d) => hoursRow(d, s.hours[String(d)]));
  const slot = field({ id: 'c-slot', label: 'Duração de cada horário (minutos)', type: 'number', inputmode: 'numeric', min: 15, max: 240, step: 15, value: s.slot_minutes });
  const cap = field({ id: 'c-cap', label: 'Carros ao mesmo tempo', type: 'number', inputmode: 'numeric', min: 1, max: 10, value: s.capacity, hint: 'Quantos clientes podem ter o mesmo horário.' });
  const lead = field({ id: 'c-lead', label: 'Antecedência mínima (minutos)', type: 'number', inputmode: 'numeric', min: 0, max: 10080, value: s.lead_minutes });
  const ahead = field({ id: 'c-ahead', label: 'Quantos dias à frente o cliente pode agendar', type: 'number', inputmode: 'numeric', min: 1, max: 60, value: s.max_days_ahead });
  const note = field({ id: 'c-note', label: 'Aviso para o cliente (opcional)', type: 'text', maxlength: 300, value: s.instructions, placeholder: 'Ex.: Chegue 10 minutos antes.' });
  const val = (f) => Number(f.querySelector('input').value);

  const copy = el('button', { class: 'btn btn-outline', type: 'button' }, 'Copiar link');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copiado.', { type: 'success' }); } catch { toast('Copie o link manualmente.', { type: 'error' }); }
  });
  const share = el('a', { class: 'btn btn-outline', target: '_blank', rel: 'noopener noreferrer', href: `https://wa.me/?text=${encodeURIComponent(inviteMessage({ businessName: session.tenant?.name ?? '', link }))}` }, 'Enviar no WhatsApp');
  const regen = el('button', { class: 'btn btn-outline', type: 'button' }, 'Gerar novo link');
  regen.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Gerar novo link?', message: 'O link antigo deixa de funcionar. Quem já agendou continua com o agendamento.', confirmLabel: 'Gerar novo' }))) return;
    const done = await runBusy(regen, () => api.put('/booking/settings', { regenerate_code: true }));
    if (done) render(done);
  });

  const save = el('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, 'Salvar');
  const form = el('form', { class: 'form', novalidate: true },
    el('div', { class: 'card section' },
      el('label', {}, enabled, ' Receber agendamentos pelo link'),
      el('p', { class: 'muted' }, 'Envie este link aos seus clientes:'),
      el('p', { class: 'link-box', id: 'booking-link' }, link),
      el('div', { class: 'appt-actions' }, copy, share, regen)),
    el('div', { class: 'card section' }, el('strong', {}, 'Horário de funcionamento'), ...rows.map((r) => r.node)),
    slot, cap, lead, ahead, note,
    el('label', {}, auto, ' Confirmar sozinho (sem eu precisar aprovar cada pedido)'),
    save);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const hours = Object.fromEntries(rows.map((r) => [String(r.day), r.open.checked ? [r.from.value, r.to.value] : null]));
    const done = await runBusy(save, () => api.put('/booking/settings', {
      enabled: enabled.checked, auto_confirm: auto.checked, hours,
      slot_minutes: val(slot), capacity: val(cap), lead_minutes: val(lead), max_days_ahead: val(ahead), instructions: note.querySelector('input').value,
    }));
    if (done) { toast('Salvo.', { type: 'success' }); render(done); }
  });
  root.replaceChildren(form);
}

async function load() {
  try {
    render(await api.get('/booking/settings'));
  } catch (error) {
    root.replaceChildren(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: load }));
  }
}

if (session) load();
