// Agendamento online. O dono envia um link (código aleatório, sem expor o id do lava-jato);
// o cliente escolhe serviço, dia e horário. A vaga é reservada de forma atômica no banco.

import { ok, readJson, errors } from './lib/http.js';
import * as v from './lib/validate.js';
import { generateToken } from './lib/crypto.js';
import { rateLimit } from './middleware.js';
import { auditStatement, actorOf } from './audit.js';
import { parsePlate } from './customers.js';
import { billingState } from './lib/billing.js';
import { today, addDays, isValidDate, daysBetween } from './lib/dates.js';

const timeZone = (env) => env.TIMEZONE || 'America/Sao_Paulo';
const ACTIVE = "('PENDENTE', 'CONFIRMADO', 'CONCLUIDO')";
const DEFAULT_HOURS = Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [String(d), ['08:00', '18:00']]));
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const MAX_PENDING_PER_PHONE = 3;

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const weekdayOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** Hora local (minutos desde 0h) no fuso do lava-jato. */
function nowMinutes(env, now = new Date()) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone(env), hour: '2-digit', minute: '2-digit', hour12: false }).format(now).split(':').map(Number);
  return h * 60 + m;
}

function parseHours(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function publicSettings(row) {
  return {
    code: row.code,
    enabled: row.enabled === 1,
    slot_minutes: row.slot_minutes,
    capacity: row.capacity,
    lead_minutes: row.lead_minutes,
    max_days_ahead: row.max_days_ahead,
    auto_confirm: row.auto_confirm === 1,
    hours: parseHours(row.hours),
    instructions: row.instructions,
  };
}

/* Configuração (ADMIN) -------------------------------------------------------------- */

async function loadSettings(env, tenantId) {
  let row = await env.DB.prepare('SELECT * FROM booking_settings WHERE tenant_id = ?').bind(tenantId).first();
  if (!row) {
    await env.DB.prepare('INSERT OR IGNORE INTO booking_settings (tenant_id, code, hours) VALUES (?, ?, ?)')
      .bind(tenantId, newCode(), JSON.stringify(DEFAULT_HOURS)).run();
    row = await env.DB.prepare('SELECT * FROM booking_settings WHERE tenant_id = ?').bind(tenantId).first();
  }
  return row;
}

function parseHoursInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw errors.validation('Horários inválidos.');
  const out = {};
  for (const [day, range] of Object.entries(value)) {
    if (!/^[0-6]$/.test(day)) throw errors.validation('Horários inválidos.');
    if (range === null) continue; // dia fechado
    if (!Array.isArray(range) || range.length !== 2 || !isTime(range[0]) || !isTime(range[1]) || toMinutes(range[0]) >= toMinutes(range[1])) {
      throw errors.validation('Horário de funcionamento inválido: a abertura deve ser antes do fechamento.');
    }
    out[day] = [range[0], range[1]];
  }
  return out;
}

const intIn = (value, min, max, field) => {
  if (!Number.isInteger(value) || value < min || value > max) throw errors.validation(`Campo "${field}" inválido.`);
  return value;
};

export async function getBookingSettings({ env, auth }) {
  return ok(publicSettings(await loadSettings(env, auth.tenantId)));
}

export async function updateBookingSettings({ request, env, auth, ip }) {
  const body = v.onlyFields(await readJson(request), ['enabled', 'slot_minutes', 'capacity', 'lead_minutes', 'max_days_ahead', 'auto_confirm', 'hours', 'instructions', 'regenerate_code']);
  const current = await loadSettings(env, auth.tenantId);
  const next = {
    enabled: body.enabled === undefined ? current.enabled : (v.bool(body.enabled, 'ativo') ? 1 : 0),
    slot_minutes: body.slot_minutes === undefined ? current.slot_minutes : intIn(body.slot_minutes, 15, 240, 'duração'),
    capacity: body.capacity === undefined ? current.capacity : intIn(body.capacity, 1, 10, 'vagas por horário'),
    lead_minutes: body.lead_minutes === undefined ? current.lead_minutes : intIn(body.lead_minutes, 0, 10080, 'antecedência'),
    max_days_ahead: body.max_days_ahead === undefined ? current.max_days_ahead : intIn(body.max_days_ahead, 1, 60, 'dias à frente'),
    auto_confirm: body.auto_confirm === undefined ? current.auto_confirm : (v.bool(body.auto_confirm, 'confirmar sozinho') ? 1 : 0),
    hours: body.hours === undefined ? current.hours : JSON.stringify(parseHoursInput(body.hours)),
    instructions: body.instructions === undefined ? current.instructions : v.optionalText(body.instructions, { field: 'o aviso', max: 300, multiline: true }),
    code: body.regenerate_code === true ? newCode() : current.code,
  };
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE booking_settings SET enabled = ?, slot_minutes = ?, capacity = ?, lead_minutes = ?, max_days_ahead = ?,
              auto_confirm = ?, hours = ?, instructions = ?, code = ?, updated_at = ? WHERE tenant_id = ?`,
    ).bind(next.enabled, next.slot_minutes, next.capacity, next.lead_minutes, next.max_days_ahead, next.auto_confirm, next.hours, next.instructions, next.code, new Date().toISOString(), auth.tenantId),
    await auditStatement(env, {
      tenantId: auth.tenantId, actor: actorOf(auth), action: 'BOOKING_SETTINGS_CHANGED', entity: 'booking', entityId: auth.tenantId,
      details: { enabled: next.enabled === 1, code_changed: next.code !== current.code }, ip,
    }),
  ]);
  return ok(publicSettings(await loadSettings(env, auth.tenantId)));
}

/* Horários livres ------------------------------------------------------------------- */

/** Horários do dia (HH:MM) conforme expediente e duração, sem considerar vagas ocupadas. */
function daySlots(settings, date) {
  const range = parseHours(settings.hours)[String(weekdayOf(date))];
  if (!range) return [];
  const slots = [];
  for (let t = toMinutes(range[0]); t + settings.slot_minutes <= toMinutes(range[1]); t += settings.slot_minutes) slots.push(toHhmm(t));
  return slots;
}

async function freeSlots(env, tenantId, settings, date) {
  const todayIso = today(timeZone(env));
  if (!isValidDate(date) || date < todayIso || daysBetween(todayIso, date) > settings.max_days_ahead) return [];
  const { results } = await env.DB.prepare(
    `SELECT time, COUNT(*) AS n FROM appointments WHERE tenant_id = ? AND date = ? AND status IN ${ACTIVE} GROUP BY time`,
  ).bind(tenantId, date).all();
  const taken = new Map(results.map((r) => [r.time, r.n]));
  const earliest = date === todayIso ? nowMinutes(env) + settings.lead_minutes : -1;
  return daySlots(settings, date).filter((t) => toMinutes(t) >= earliest && (taken.get(t) ?? 0) < settings.capacity);
}

/* API pública ------------------------------------------------------------------------ */

async function bookableTenant(env, code) {
  if (typeof code !== 'string' || !/^[a-z0-9]{12}$/.test(code)) throw errors.notFound('Link de agendamento inválido.');
  const row = await env.DB.prepare(
    `SELECT b.*, t.id AS tid, t.business_name, t.phone AS tenant_phone, t.status, t.subscription_status, t.paid_until
       FROM booking_settings b JOIN tenants t ON t.id = b.tenant_id WHERE b.code = ?`,
  ).bind(code).first();
  const available = row && row.enabled === 1 && row.status === 'ATIVO' && billingState(row, today(timeZone(env))).access;
  if (!available) throw errors.notFound('Este link de agendamento não está disponível.');
  return row;
}

export async function publicInfo({ env, params, ip }) {
  await rateLimit(env, `book:info:${ip}`, 120, 600);
  const row = await bookableTenant(env, params.code);
  const { results } = await env.DB.prepare('SELECT id, name, price_cents FROM services WHERE tenant_id = ? AND active = 1 ORDER BY name COLLATE NOCASE')
    .bind(row.tid).all();
  return ok({
    business_name: row.business_name,
    phone: row.tenant_phone,
    instructions: row.instructions,
    max_days_ahead: row.max_days_ahead,
    open_weekdays: Object.keys(parseHours(row.hours)).map(Number),
    services: results,
  });
}

export async function publicSlots({ env, params, url, ip }) {
  await rateLimit(env, `book:slots:${ip}`, 120, 600);
  const row = await bookableTenant(env, params.code);
  const date = url.searchParams.get('date') ?? '';
  if (!isValidDate(date)) throw errors.validation('Data inválida.');
  return ok({ date, slots: await freeSlots(env, row.tid, row, date) });
}

export async function publicCreate({ request, env, params, ip }) {
  await rateLimit(env, `book:create:${ip}`, 10, 3600);
  const row = await bookableTenant(env, params.code);
  const body = v.onlyFields(await readJson(request), ['service_id', 'date', 'time', 'name', 'phone', 'plate', 'vehicle', 'notes', 'website']);
  // Campo-isca: pessoas não o veem; robôs o preenchem. Responde como sucesso sem gravar nada.
  if (body.website) return ok({ status: 'PENDENTE' }, 201);

  const serviceId = v.bodyId(body.service_id, 'serviço');
  const data = {
    name: v.text(body.name, { field: 'seu nome', min: 2, max: 80 }),
    phone: v.phone(body.phone),
    plate: parsePlate(body.plate),
    vehicle: v.optionalText(body.vehicle, { field: 'o veículo', max: 60 }),
    notes: v.optionalText(body.notes, { field: 'a observação', max: 200, multiline: true }),
  };
  if (!data.phone) throw errors.validation('Informe seu telefone com DDD.');
  if (!isValidDate(body.date) || !isTime(body.time)) throw errors.validation('Escolha um dia e um horário.');
  await rateLimit(env, `book:phone:${row.tid}:${data.phone}`, 5, 3600);

  const service = await env.DB.prepare('SELECT id, name FROM services WHERE id = ? AND tenant_id = ? AND active = 1').bind(serviceId, row.tid).first();
  if (!service) throw errors.validation('Escolha um serviço.');

  if (!(await freeSlots(env, row.tid, row, body.date)).includes(body.time)) {
    throw errors.conflict('Esse horário não está mais disponível. Escolha outro.');
  }
  const open = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM appointments WHERE tenant_id = ? AND phone = ? AND status IN ('PENDENTE', 'CONFIRMADO') AND date >= ?`,
  ).bind(row.tid, data.phone, today(timeZone(env))).first();
  if (open.n >= MAX_PENDING_PER_PHONE) throw errors.conflict('Você já tem agendamentos em aberto. Cancele um deles ou fale com o lava-jato.');

  const token = generateToken();
  const status = row.auto_confirm === 1 ? 'CONFIRMADO' : 'PENDENTE';
  // Reserva atômica: só insere se o horário ainda tem vaga (duas pessoas ao mesmo tempo não passam das vagas).
  const [insert] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO appointments (tenant_id, service_id, customer_name, phone, plate, vehicle, notes, date, time, status, source, public_token)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'LINK', ?11
        WHERE (SELECT COUNT(*) FROM appointments WHERE tenant_id = ?1 AND date = ?8 AND time = ?9 AND status IN ${ACTIVE}) < ?12`,
    ).bind(row.tid, service.id, data.name, data.phone, data.plate, data.vehicle, data.notes, body.date, body.time, status, token, row.capacity),
    await auditStatement(env, {
      tenantId: row.tid, actor: { type: 'ANONYMOUS' }, action: 'APPOINTMENT_CREATED', entity: 'appointment', entityId: null,
      details: { source: 'LINK', date: body.date, time: body.time, service: service.name, status }, ip, onlyIfChanged: true,
    }),
  ]);
  if (insert.meta.changes === 0) throw errors.conflict('Esse horário acabou de ser preenchido. Escolha outro.');
  return ok({ status, token, date: body.date, time: body.time, service: service.name, business_name: row.business_name }, 201);
}

async function findByToken(env, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw errors.notFound();
  const row = await env.DB.prepare(
    `SELECT a.id, a.tenant_id, a.date, a.time, a.status, s.name AS service, t.business_name, t.phone AS tenant_phone
       FROM appointments a JOIN services s ON s.tenant_id = a.tenant_id AND s.id = a.service_id
       JOIN tenants t ON t.id = a.tenant_id WHERE a.public_token = ?`,
  ).bind(token).first();
  if (!row) throw errors.notFound('Agendamento não encontrado.');
  return row;
}

const publicView = (r) => ({ date: r.date, time: r.time, status: r.status, service: r.service, business_name: r.business_name, phone: r.tenant_phone });

export async function publicView_({ env, params, ip }) {
  await rateLimit(env, `book:view:${ip}`, 60, 600);
  return ok(publicView(await findByToken(env, params.token)));
}

export async function publicCancel({ env, params, ip }) {
  await rateLimit(env, `book:cancel:${ip}`, 20, 3600);
  const row = await findByToken(env, params.token);
  if (!['PENDENTE', 'CONFIRMADO'].includes(row.status)) throw errors.invalidState('Este agendamento não pode mais ser cancelado.');
  await env.DB.batch([
    env.DB.prepare(`UPDATE appointments SET status = 'CANCELADO', updated_at = ? WHERE id = ? AND status IN ('PENDENTE', 'CONFIRMADO')`).bind(new Date().toISOString(), row.id),
    await auditStatement(env, { tenantId: row.tenant_id, actor: { type: 'ANONYMOUS' }, action: 'APPOINTMENT_CANCELLED_BY_CUSTOMER', entity: 'appointment', entityId: row.id, details: { date: row.date, time: row.time }, ip, onlyIfChanged: true }),
  ]);
  return ok({ ...publicView(row), status: 'CANCELADO' });
}

/* Agenda do lava-jato (ADMIN e OPERADOR) ----------------------------------------------- */

const COLUMNS = `a.id, a.service_id, s.name AS service_name, s.price_cents, a.customer_name, a.phone, a.plate, a.vehicle, a.notes,
                 a.date, a.time, a.status, a.source`;

export async function listAppointments({ env, auth, url }) {
  const date = url.searchParams.get('date') ?? today(timeZone(env));
  if (!isValidDate(date)) throw errors.validation('Data inválida.');
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM appointments a JOIN services s ON s.tenant_id = a.tenant_id AND s.id = a.service_id
      WHERE a.tenant_id = ? AND a.date = ? ORDER BY a.time, a.id`,
  ).bind(auth.tenantId, date).all();
  return ok({ date, items: results });
}

export async function appointmentsSummary({ env, auth }) {
  const todayIso = today(timeZone(env));
  const row = await env.DB.prepare(
    `SELECT SUM(status = 'PENDENTE' AND date >= ?1) AS pending,
            SUM(date = ?1 AND status IN ('PENDENTE', 'CONFIRMADO')) AS today
       FROM appointments WHERE tenant_id = ?2`,
  ).bind(todayIso, auth.tenantId).first();
  return ok({ pending: row.pending ?? 0, today: row.today ?? 0 });
}

export async function createAppointment({ request, env, auth, ip }) {
  const body = v.onlyFields(await readJson(request), ['service_id', 'date', 'time', 'name', 'phone', 'plate', 'vehicle', 'notes']);
  if (!isValidDate(body.date) || body.date < today(timeZone(env))) throw errors.validation('Escolha uma data de hoje em diante.');
  if (!isTime(body.time)) throw errors.validation('Horário inválido.');
  const phone = v.phone(body.phone);
  if (!phone) throw errors.validation('Informe o telefone com DDD.');
  const service = await env.DB.prepare('SELECT id, name FROM services WHERE id = ? AND tenant_id = ? AND active = 1').bind(v.bodyId(body.service_id, 'serviço'), auth.tenantId).first();
  if (!service) throw errors.validation('Escolha um serviço.');
  const token = generateToken();
  const [insert] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO appointments (tenant_id, service_id, customer_name, phone, plate, vehicle, notes, date, time, status, source, public_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMADO', 'MANUAL', ?) RETURNING id`,
    ).bind(auth.tenantId, service.id, v.text(body.name, { field: 'o nome', min: 2, max: 80 }), phone, parsePlate(body.plate),
      v.optionalText(body.vehicle, { field: 'o veículo', max: 60 }), v.optionalText(body.notes, { field: 'a observação', max: 200, multiline: true }), body.date, body.time, token),
    await auditStatement(env, { tenantId: auth.tenantId, actor: actorOf(auth), action: 'APPOINTMENT_CREATED', entity: 'appointment', entityId: null, details: { source: 'MANUAL', date: body.date, time: body.time, service: service.name }, ip, onlyIfChanged: true }),
  ]);
  return ok({ id: insert.results[0].id }, 201);
}

const TRANSITIONS = {
  PENDENTE: ['CONFIRMADO', 'CANCELADO', 'CONCLUIDO', 'FALTOU'],
  CONFIRMADO: ['CONCLUIDO', 'CANCELADO', 'FALTOU'],
};

export async function updateAppointment({ request, env, auth, params, ip }) {
  const body = v.onlyFields(await readJson(request), ['status', 'date', 'time']);
  const id = v.id(params.id);
  const row = await env.DB.prepare('SELECT id, status, date, time FROM appointments WHERE id = ? AND tenant_id = ?').bind(id, auth.tenantId).first();
  if (!row) throw errors.notFound('Agendamento não encontrado.');
  if (!TRANSITIONS[row.status]) throw errors.invalidState('Este agendamento já foi encerrado.');

  const status = body.status === undefined ? row.status : v.oneOf(body.status, ['CONFIRMADO', 'CONCLUIDO', 'CANCELADO', 'FALTOU'], 'situação');
  if (status !== row.status && !TRANSITIONS[row.status].includes(status)) throw errors.invalidState();
  const date = body.date === undefined ? row.date : body.date;
  const time = body.time === undefined ? row.time : body.time;
  if (!isValidDate(date) || !isTime(time)) throw errors.validation('Data ou horário inválido.');
  const moved = date !== row.date || time !== row.time;
  if (moved && ['CONCLUIDO', 'CANCELADO', 'FALTOU'].includes(status)) throw errors.validation('Só é possível remarcar agendamentos em aberto.');
  if (moved && date < today(timeZone(env))) throw errors.validation('Escolha uma data de hoje em diante.');

  const settings = await loadSettings(env, auth.tenantId);
  const [update] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE appointments SET status = ?1, date = ?2, time = ?3, updated_at = ?4
        WHERE id = ?5 AND tenant_id = ?6 AND status = ?7
          AND (?8 = 0 OR (SELECT COUNT(*) FROM appointments WHERE tenant_id = ?6 AND date = ?2 AND time = ?3 AND status IN ${ACTIVE} AND id <> ?5) < ?9)`,
    ).bind(status, date, time, new Date().toISOString(), id, auth.tenantId, row.status, moved ? 1 : 0, settings.capacity),
    await auditStatement(env, { tenantId: auth.tenantId, actor: actorOf(auth), action: 'APPOINTMENT_UPDATED', entity: 'appointment', entityId: id, details: { before: { status: row.status, date: row.date, time: row.time }, after: { status, date, time } }, ip, onlyIfChanged: true }),
  ]);
  if (update.meta.changes === 0) throw errors.conflict('Não foi possível atualizar: o horário está cheio ou o agendamento mudou. Atualize a tela.');
  return ok({ id, status, date, time });
}
