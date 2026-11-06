// Página pública de agendamento (sem login). O cliente escolhe serviço, dia e horário.

import { config } from './config.js';
import { el, field, validateFields, runBusy } from './ui.js';
import { formatCents } from './format.js';
import { dayLabel, addDaysISO, WEEKDAY_NAMES } from './agenda-text.js';

const root = document.getElementById('booking');
const code = new URLSearchParams(location.search).get('c') ?? '';
const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: config.TIMEZONE }).format(new Date());

async function call(method, path, body) {
  let response;
  try {
    response = await fetch(config.API_BASE_URL + path, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new Error('Sem conexão com o servidor. Verifique sua internet.');
  }
  const payload = await response.json().catch(() => null);
  if (payload?.success) return payload.data;
  throw new Error(payload?.error?.message ?? 'Não foi possível concluir. Tente novamente.');
}

function show(...nodes) {
  root.replaceChildren(...nodes);
}

function header(info) {
  return el('div', { class: 'brand' },
    el('img', { src: 'assets/icons/icon-192.png', alt: '', width: 64, height: 64 }),
    el('h1', {}, info.business_name),
    el('p', { class: 'muted' }, 'Agende seu horário'));
}

function unavailable(message) {
  show(el('div', { class: 'brand' }, el('h1', {}, 'Agendamento indisponível'), el('p', { class: 'muted' }, message)));
}

function showDone(info, result) {
  const cancelLink = `${location.href.split('?')[0]}?t=${encodeURIComponent(result.token)}`;
  show(
    header(info),
    el('div', { class: 'card section' },
      el('h2', {}, result.status === 'CONFIRMADO' ? 'Horário confirmado!' : 'Pedido enviado!'),
      el('p', {}, `${result.service} · ${dayLabel(result.date)} às ${result.time}`),
      el('p', { class: 'muted' }, result.status === 'CONFIRMADO' ? 'Esperamos você.' : 'O lava-jato vai confirmar seu horário em breve. Guarde o link abaixo para consultar ou cancelar.'),
      el('a', { class: 'btn btn-outline btn-block', href: cancelLink }, 'Ver ou cancelar meu agendamento'),
    ));
}

async function showBooking(token) {
  let data;
  try {
    data = await call('GET', `/public/appointments/${encodeURIComponent(token)}`);
  } catch (error) {
    unavailable(error.message);
    return;
  }
  const cancellable = ['PENDENTE', 'CONFIRMADO'].includes(data.status);
  const labels = { PENDENTE: 'Aguardando confirmação', CONFIRMADO: 'Confirmado', CONCLUIDO: 'Concluído', CANCELADO: 'Cancelado', FALTOU: 'Não compareceu' };
  const cancel = el('button', { class: 'btn btn-danger btn-block', type: 'button' }, 'Cancelar agendamento');
  cancel.addEventListener('click', async () => {
    if (!window.confirm('Cancelar este agendamento?')) return;
    const done = await runBusy(cancel, () => call('POST', `/public/appointments/${encodeURIComponent(token)}/cancel`));
    if (done) showBooking(token);
  });
  show(
    el('div', { class: 'brand' }, el('h1', {}, data.business_name), el('p', { class: 'muted' }, 'Seu agendamento')),
    el('div', { class: 'card section' },
      el('p', {}, el('strong', {}, data.service)),
      el('p', {}, `${dayLabel(data.date)} às ${data.time}`),
      el('p', { class: 'muted' }, labels[data.status] ?? data.status),
      cancellable ? cancel : null,
    ));
}

async function showForm(info) {
  let serviceId = null;
  let date = null;
  let time = null;

  const services = el('div', { class: 'chips chips-wrap', role: 'group', 'aria-label': 'Serviço' });
  const days = el('div', { class: 'chips chips-wrap', role: 'group', 'aria-label': 'Dia' });
  const slots = el('div', { class: 'chips chips-wrap', role: 'group', 'aria-label': 'Horário', 'aria-live': 'polite' });
  const slotsHint = el('p', { class: 'hint' }, 'Escolha um dia para ver os horários.');
  const choiceError = el('span', { class: 'field-error', role: 'alert' });

  const paint = (box, value) => [...box.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === String(value))));
  const chip = (box, label, value, onPick) => el('button', {
    class: 'chip', type: 'button', 'data-value': String(value), 'aria-pressed': 'false',
    onclick: () => { onPick(value); paint(box, value); choiceError.textContent = ''; },
  }, label);

  services.append(...info.services.map((s) => chip(services, `${s.name} · ${formatCents(s.price_cents)}`, s.id, (v) => { serviceId = v; })));

  async function loadSlots(day) {
    slots.replaceChildren();
    time = null;
    slotsHint.textContent = 'Buscando horários...';
    try {
      const { slots: free } = await call('GET', `/public/booking/${encodeURIComponent(code)}/slots?date=${day}`);
      slotsHint.textContent = free.length ? '' : 'Sem horários livres neste dia. Escolha outro dia.';
      slots.append(...free.map((t) => chip(slots, t, t, (v) => { time = v; })));
    } catch (error) {
      slotsHint.textContent = error.message;
    }
  }

  const start = todayISO();
  const open = new Set(info.open_weekdays);
  for (let i = 0; i <= info.max_days_ahead; i += 1) {
    const iso = addDaysISO(start, i);
    if (!open.has(new Date(`${iso}T00:00:00Z`).getUTCDay())) continue;
    const label = i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : `${WEEKDAY_NAMES[new Date(`${iso}T00:00:00Z`).getUTCDay()].slice(0, 3)} ${iso.slice(8)}/${iso.slice(5, 7)}`;
    days.append(chip(days, label, iso, (v) => { date = v; loadSlots(v); }));
  }

  const name = field({ id: 'b-name', label: 'Seu nome', type: 'text', maxlength: 80, autocomplete: 'name' });
  const phone = field({ id: 'b-phone', label: 'WhatsApp (com DDD)', type: 'tel', inputmode: 'tel', maxlength: 20, autocomplete: 'tel', placeholder: '(11) 98888-7777' });
  const vehicle = field({ id: 'b-vehicle', label: 'Veículo (opcional)', type: 'text', maxlength: 60, placeholder: 'Ex.: Gol branco', autocomplete: 'off' });
  const plate = field({ id: 'b-plate', label: 'Placa (opcional)', type: 'text', maxlength: 9, placeholder: 'ABC1D23', autocapitalize: 'characters', autocomplete: 'off' });
  // Campo-isca contra robôs: invisível para pessoas.
  const trap = el('input', { class: 'hp-field', type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const submit = el('button', { class: 'btn btn-primary btn-block btn-lg', type: 'submit' }, 'Pedir horário');
  const formAlert = el('div', { class: 'form-alert', role: 'alert', hidden: true });

  const form = el('form', { class: 'form', novalidate: true },
    el('div', { class: 'field' }, el('span', { class: 'stat-label' }, 'Serviço'), services),
    el('div', { class: 'field' }, el('span', { class: 'stat-label' }, 'Dia'), days),
    el('div', { class: 'field' }, el('span', { class: 'stat-label' }, 'Horário'), slots, slotsHint),
    choiceError,
    name, phone, vehicle, plate, trap, formAlert, submit);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    formAlert.hidden = true;
    const fieldsOk = validateFields([
      [name.querySelector('input'), (v) => (v.trim().length < 2 ? 'Informe seu nome.' : null)],
      [phone.querySelector('input'), (v) => (v.replace(/\D/g, '').length < 10 ? 'Informe o telefone com DDD.' : null)],
    ]);
    if (!serviceId || !date || !time) {
      choiceError.textContent = 'Escolha o serviço, o dia e o horário.';
      return;
    }
    if (!fieldsOk) return;
    const result = await runBusy(submit, () => call('POST', `/public/booking/${encodeURIComponent(code)}/appointments`, {
      service_id: serviceId, date, time,
      name: name.querySelector('input').value, phone: phone.querySelector('input').value,
      vehicle: vehicle.querySelector('input').value, plate: plate.querySelector('input').value, website: trap.value,
    }).catch((error) => { formAlert.textContent = error.message; formAlert.hidden = false; if (date) loadSlots(date); return null; }));
    if (result) {
      try { history.replaceState(null, '', `${location.pathname}?t=${encodeURIComponent(result.token)}`); } catch { /* sem histórico */ }
      showDone(info, result);
    }
  });

  show(header(info), info.instructions ? el('p', { class: 'card muted' }, info.instructions) : null, form);
}

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.get('t')) return showBooking(params.get('t'));
  if (!/^[a-z0-9]{12}$/.test(code)) return unavailable('Link de agendamento inválido.');
  try {
    return await showForm(await call('GET', `/public/booking/${encodeURIComponent(code)}`));
  } catch (error) {
    return unavailable(error.message);
  }
}

init();
