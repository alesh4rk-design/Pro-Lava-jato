// Agenda do dia (ADMIN e OPERADOR): confirmar, concluir, remarcar, cancelar e avisar o cliente pelo WhatsApp.

import { session } from './app.js';
import { api } from './api.js';
import { config } from './config.js';
import { todayISO, formatCents, formatPhone } from './format.js';
import { el, field, chipGroup, toast, openModal, stateView, runBusy, confirmDialog } from './ui.js';
import { getServices } from './catalog.js';
import { whatsappUrl, vehicleText } from './whatsapp.js';
import { STATUS_LABELS, dayLabel, addDaysISO, confirmationMessage } from './agenda-text.js';

const list = document.getElementById('agenda-list');
const dayInput = document.getElementById('day-input');
const today = todayISO(config.TIMEZONE);
let day = new URLSearchParams(location.search).get('dia') || today;

const BADGE = { PENDENTE: 'badge-warning', CONFIRMADO: 'badge-primary', CONCLUIDO: 'badge-success', CANCELADO: 'badge-danger', FALTOU: 'badge-danger' };

async function setStatus(item, status, button) {
  const done = await runBusy(button, () => api.put(`/appointments/${item.id}`, { status }));
  if (done) { toast('Agenda atualizada.', { type: 'success' }); load(); }
}

function openReschedule(item) {
  const date = field({ id: 'rs-date', label: 'Novo dia', type: 'date', min: today, value: item.date });
  const time = field({ id: 'rs-time', label: 'Novo horário', type: 'time', value: item.time });
  openModal({
    title: 'Remarcar',
    content: el('form', { class: 'form', novalidate: true }, date, time),
    actions: [
      { label: 'Voltar', variant: 'btn-outline' },
      {
        label: 'Remarcar', variant: 'btn-primary',
        onClick: async (close, button) => {
          const done = await runBusy(button, () => api.put(`/appointments/${item.id}`, { date: date.querySelector('input').value, time: time.querySelector('input').value }));
          if (done) { close(); toast('Horário remarcado.', { type: 'success' }); day = done.date; load(); }
        },
      },
    ],
  });
}

function card(item) {
  const open = item.status === 'PENDENTE' || item.status === 'CONFIRMADO';
  const wa = whatsappUrl(item.phone, confirmationMessage({ name: item.customer_name.split(' ')[0], service: item.service_name, date: item.date, time: item.time, businessName: session.tenant?.name ?? config.APP_NAME }));
  const actions = [];
  const btn = (label, cls, fn) => { const b = el('button', { class: `btn ${cls}`, type: 'button' }, label); b.addEventListener('click', () => fn(b)); actions.push(b); };
  if (item.status === 'PENDENTE') btn('Confirmar', 'btn-primary', (b) => setStatus(item, 'CONFIRMADO', b));
  if (open) {
    btn('Concluir', 'btn-outline', (b) => setStatus(item, 'CONCLUIDO', b));
    btn('Remarcar', 'btn-outline', () => openReschedule(item));
    btn('Não veio', 'btn-outline', async (b) => { if (await confirmDialog({ title: 'Não compareceu?', message: `Marcar ${item.customer_name} como não compareceu?`, confirmLabel: 'Marcar' })) setStatus(item, 'FALTOU', b); });
    btn('Cancelar', 'btn-outline', async (b) => { if (await confirmDialog({ title: 'Cancelar agendamento?', message: `O horário de ${item.customer_name} ficará livre.`, confirmLabel: 'Cancelar agendamento', danger: true })) setStatus(item, 'CANCELADO', b); });
  }
  if (wa) actions.push(el('a', { class: 'btn btn-outline', href: wa, target: '_blank', rel: 'noopener noreferrer' }, 'WhatsApp'));
  return el('article', { class: `card appt-card${open ? '' : ' is-closed'}` },
    el('div', { class: 'appt-head' }, el('span', { class: 'appt-time' }, item.time), el('span', { class: `badge ${BADGE[item.status]}` }, STATUS_LABELS[item.status])),
    el('strong', {}, item.customer_name),
    el('span', {}, `${item.service_name} · ${formatCents(item.price_cents)}`),
    vehicleText(item) ? el('span', { class: 'muted' }, vehicleText(item)) : null,
    el('span', { class: 'muted' }, `${formatPhone(item.phone)}${item.source === 'LINK' ? ' · pelo link' : ''}`),
    item.notes ? el('span', { class: 'muted' }, item.notes) : null,
    actions.length ? el('div', { class: 'appt-actions' }, actions) : null);
}

async function load() {
  dayInput.value = day;
  list.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'skeleton sk-line' })));
  try {
    const { items } = await api.get(`/appointments?date=${day}`);
    list.replaceChildren(el('p', { class: 'day-title' }, `${dayLabel(day)}${day === today ? ' (hoje)' : ''}`),
      ...(items.length ? items.map(card) : [stateView({ title: 'Nada agendado', message: 'Nenhum horário marcado para este dia.' })]));
  } catch (error) {
    list.replaceChildren(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: load }));
  }
}

async function openNew() {
  let services;
  try { services = await getServices(); } catch (error) { toast(error.message, { type: 'error' }); return; }
  const service = chipGroup({ label: 'Serviço', options: services.map((s) => ({ value: s.id, label: s.name, hint: formatCents(s.price_cents) })), value: undefined });
  const date = field({ id: 'n-date', label: 'Dia', type: 'date', min: today, value: day < today ? today : day });
  const time = field({ id: 'n-time', label: 'Horário', type: 'time', value: '09:00' });
  const name = field({ id: 'n-name', label: 'Nome do cliente', type: 'text', maxlength: 80, autocomplete: 'off' });
  const phone = field({ id: 'n-phone', label: 'Telefone (com DDD)', type: 'tel', inputmode: 'tel', maxlength: 20, autocomplete: 'off' });
  const plate = field({ id: 'n-plate', label: 'Placa (opcional)', type: 'text', maxlength: 9, autocapitalize: 'characters', autocomplete: 'off' });
  const vehicle = field({ id: 'n-vehicle', label: 'Veículo (opcional)', type: 'text', maxlength: 60, autocomplete: 'off' });
  const val = (f) => f.querySelector('input').value;
  openModal({
    title: 'Novo agendamento',
    content: el('form', { class: 'form', novalidate: true }, el('div', { class: 'field' }, el('span', { class: 'stat-label' }, 'Serviço'), service.element), date, time, name, phone, vehicle, plate),
    actions: [
      { label: 'Voltar', variant: 'btn-outline' },
      {
        label: 'Agendar', variant: 'btn-primary',
        onClick: async (close, button) => {
          if (!service.value) { toast('Escolha o serviço.', { type: 'error' }); return; }
          const done = await runBusy(button, () => api.post('/appointments', { service_id: service.value, date: val(date), time: val(time), name: val(name), phone: val(phone), vehicle: val(vehicle), plate: val(plate) }));
          if (done) { close(); toast('Agendado.', { type: 'success' }); day = val(date); load(); }
        },
      },
    ],
  });
}

if (session) {
  const go = (d) => { day = d; load(); };
  document.getElementById('day-prev').addEventListener('click', () => go(addDaysISO(day, -1)));
  document.getElementById('day-next').addEventListener('click', () => go(addDaysISO(day, 1)));
  document.getElementById('day-today').addEventListener('click', () => go(today));
  dayInput.addEventListener('change', () => { if (dayInput.value) go(dayInput.value); });
  document.getElementById('new-item').addEventListener('click', openNew);
  load();
}
