// Clientes do lava-jato e mensagens prontas de WhatsApp.
// Clientes: ADMIN e OPERADOR cadastram, editam e registram contato. Mensagens: todos usam, só ADMIN edita.
// O servidor nunca envia WhatsApp: o app abre o link wa.me com a mensagem preenchida e a pessoa toca em enviar.

import { ok, readJson, errors } from './lib/http.js';
import * as v from './lib/validate.js';
import { auditStatement, actorOf } from './audit.js';

const PAGE_SIZE = 50;
const MAX_CUSTOMERS = 5000;
const MAX_TEMPLATES = 30;

/* Clientes ------------------------------------------------------------------------- */

const COLUMNS = 'id, name, phone, vehicle, plate, notes, active, last_contact_at, created_at';
const toPublic = (row) => ({ ...row, active: row.active === 1 });

function parsePlate(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw errors.validation('Placa inválida.');
  const plate = value.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{5,8}$/.test(plate)) throw errors.validation('Placa inválida. Ex.: ABC1D23');
  return plate;
}

function parsePhone(value) {
  const digits = v.phone(value);
  if (!digits) throw errors.validation('Informe o telefone com DDD.');
  return digits;
}

const FIELDS = ['name', 'phone', 'vehicle', 'plate', 'notes'];

function parseCustomer(body, { partial = false } = {}) {
  const data = {};
  const has = (key) => !partial || body[key] !== undefined;
  if (has('name')) data.name = v.text(body.name, { field: 'o nome', min: 2, max: 80 });
  if (has('phone')) data.phone = parsePhone(body.phone);
  if (body.vehicle !== undefined) data.vehicle = v.optionalText(body.vehicle, { field: 'o veículo', max: 60 });
  else if (!partial) data.vehicle = '';
  if (body.plate !== undefined) data.plate = parsePlate(body.plate);
  else if (!partial) data.plate = '';
  if (body.notes !== undefined) data.notes = v.optionalText(body.notes, { field: 'a observação', max: 300, multiline: true });
  else if (!partial) data.notes = '';
  return data;
}

async function findCustomer(env, auth, idParam) {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM customers WHERE tenant_id = ? AND id = ?`).bind(auth.tenantId, v.id(idParam)).first();
  if (!row) throw errors.notFound('Cliente não encontrado.');
  return row;
}

export async function listCustomers({ env, auth, url }) {
  const params = url.searchParams;
  const where = ['tenant_id = ?'];
  const binds = [auth.tenantId];
  if (params.get('include_inactive') !== '1') where.push('active = 1');
  const pattern = v.likePattern(params.get('q'));
  if (pattern) {
    where.push(`(name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR plate LIKE ? ESCAPE '\\' OR vehicle LIKE ? ESCAPE '\\')`);
    binds.push(pattern, pattern, pattern, pattern);
  }
  const page = v.page(params);
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM customers WHERE ${where.join(' AND ')} ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?`,
  ).bind(...binds, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE).all();
  return ok({ items: results.slice(0, PAGE_SIZE).map(toPublic), page, has_more: results.length > PAGE_SIZE });
}

export async function createCustomer({ request, env, auth, ip }) {
  const data = parseCustomer(v.onlyFields(await readJson(request), FIELDS));
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ?').bind(auth.tenantId).first();
  if (count.n >= MAX_CUSTOMERS) throw errors.invalidState('Limite de clientes atingido.');
  const names = Object.keys(data);
  const [inserted] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO customers (tenant_id, created_by, ${names.join(', ')}) VALUES (?, ?, ${names.map(() => '?').join(', ')}) RETURNING ${COLUMNS}`)
      .bind(auth.tenantId, auth.userId, ...names.map((n) => data[n])),
    // Telefone é dado pessoal: a auditoria guarda só o nome.
    await auditStatement(env, { tenantId: auth.tenantId, actor: actorOf(auth), action: 'CUSTOMER_CREATED', entity: 'customer', details: { name: data.name }, ip }),
  ]);
  return ok(toPublic(inserted.results[0]), 201);
}

export async function updateCustomer({ request, env, auth, params, ip }) {
  const current = await findCustomer(env, auth, params.id);
  const body = v.onlyFields(await readJson(request), [...FIELDS, 'active']);
  const changes = parseCustomer(body, { partial: true });
  if (body.active !== undefined) changes.active = v.bool(body.active, 'ativo') ? 1 : 0;
  const columns = Object.keys(changes).filter((c) => changes[c] !== current[c]);
  if (!Object.keys(changes).length) throw errors.validation('Nada para alterar.');
  if (columns.length) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE customers SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND tenant_id = ?`)
        .bind(...columns.map((c) => changes[c]), new Date().toISOString(), current.id, auth.tenantId),
      await auditStatement(env, {
        tenantId: auth.tenantId, actor: actorOf(auth), action: 'CUSTOMER_UPDATED', entity: 'customer', entityId: current.id,
        details: { name: current.name, fields: columns.filter((c) => c !== 'phone' && c !== 'notes'), contact_changed: columns.includes('phone') }, ip,
      }),
    ]);
  }
  return ok(toPublic(await findCustomer(env, auth, String(current.id))));
}

/** Registra que a equipe abriu o WhatsApp para este cliente (data do último contato e auditoria). */
export async function registerContact({ request, env, auth, params, ip }) {
  const customer = await findCustomer(env, auth, params.id);
  const body = v.onlyFields(await readJson(request), ['template_id']);
  let template = null;
  if (body.template_id !== undefined && body.template_id !== null) {
    template = await env.DB.prepare('SELECT id, title FROM message_templates WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, v.bodyId(body.template_id, 'mensagem')).first();
    if (!template) throw errors.validation('Mensagem inválida.');
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE customers SET last_contact_at = ? WHERE id = ? AND tenant_id = ?').bind(now, customer.id, auth.tenantId),
    await auditStatement(env, {
      tenantId: auth.tenantId, actor: actorOf(auth), action: 'CUSTOMER_CONTACTED', entity: 'customer', entityId: customer.id,
      details: { name: customer.name, template: template?.title ?? null }, ip,
    }),
  ]);
  return ok({ last_contact_at: now });
}

/* Mensagens prontas ----------------------------------------------------------------- */

// {nome}, {veiculo} (modelo e placa), {placa} e {lavajato}; o app troca pelos dados do cliente na hora de enviar.
export const PLACEHOLDERS = ['nome', 'veiculo', 'placa', 'lavajato'];

const DEFAULT_TEMPLATES = [
  ['Veículo pronto', 'Olá, {nome}! A limpeza do seu veículo {veiculo} já foi concluída. Pode vir retirar quando quiser. — {lavajato}'],
  ['Serviço iniciado', 'Olá, {nome}! Recebemos o seu veículo {veiculo} e já começamos o serviço. Avisaremos assim que estiver pronto. — {lavajato}'],
  ['Agradecimento', 'Olá, {nome}! Obrigado por escolher o {lavajato}. Foi um prazer cuidar do seu veículo. Volte sempre!'],
  ['Lembrete de retorno', 'Olá, {nome}! Já faz um tempinho desde a última lavagem do seu veículo {veiculo}. Que tal agendar uma nova? — {lavajato}'],
  ['Promoção da semana', 'Olá, {nome}! Temos uma condição especial esta semana no {lavajato}. Fale com a gente para saber mais.'],
];

function parseBody(value) {
  const body = v.text(value, { field: 'a mensagem', min: 2, max: 500, multiline: true });
  const unknown = [...body.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]).find((name) => !PLACEHOLDERS.includes(name));
  if (unknown !== undefined) throw errors.validation(`O campo {${unknown}} não existe. Use: ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.`);
  return body;
}

/** Cria as mensagens padrão uma única vez por lava-jato (marca em settings; vale também para lava-jatos antigos). */
async function seedTemplates(env, tenantId) {
  const guard = "NOT EXISTS (SELECT 1 FROM settings WHERE tenant_id = ?1 AND key = 'templates_seeded')";
  await env.DB.batch([
    ...DEFAULT_TEMPLATES.map(([title, body]) => env.DB.prepare(`INSERT INTO message_templates (tenant_id, title, body) SELECT ?1, ?2, ?3 WHERE ${guard}`).bind(tenantId, title, body)),
    env.DB.prepare("INSERT OR IGNORE INTO settings (tenant_id, key, value) VALUES (?, 'templates_seeded', '1')").bind(tenantId),
  ]);
}

const TEMPLATE_COLUMNS = 'id, title, body, active';
const templatePublic = (row) => ({ ...row, active: row.active === 1 });

export async function listTemplates({ env, auth, url }) {
  await seedTemplates(env, auth.tenantId);
  const all = auth.role === 'ADMIN' && url.searchParams.get('include_inactive') === '1';
  const { results } = await env.DB.prepare(
    `SELECT ${TEMPLATE_COLUMNS} FROM message_templates WHERE tenant_id = ? ${all ? '' : 'AND active = 1'} ORDER BY active DESC, id LIMIT 100`,
  ).bind(auth.tenantId).all();
  return ok({ items: results.map(templatePublic), placeholders: PLACEHOLDERS });
}

export async function createTemplate({ request, env, auth, ip }) {
  const body = v.onlyFields(await readJson(request), ['title', 'body']);
  const data = { title: v.text(body.title, { field: 'o título', min: 2, max: 60 }), body: parseBody(body.body) };
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM message_templates WHERE tenant_id = ? AND active = 1').bind(auth.tenantId).first();
  if (count.n >= MAX_TEMPLATES) throw errors.invalidState('Limite de mensagens atingido. Desative alguma antes de criar outra.');
  const [inserted] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO message_templates (tenant_id, title, body) VALUES (?, ?, ?) RETURNING ${TEMPLATE_COLUMNS}`).bind(auth.tenantId, data.title, data.body),
    await auditStatement(env, { tenantId: auth.tenantId, actor: actorOf(auth), action: 'TEMPLATE_CREATED', entity: 'message_template', details: { title: data.title }, ip }),
  ]);
  return ok(templatePublic(inserted.results[0]), 201);
}

export async function updateTemplate({ request, env, auth, params, ip }) {
  const current = await env.DB.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM message_templates WHERE tenant_id = ? AND id = ?`).bind(auth.tenantId, v.id(params.id)).first();
  if (!current) throw errors.notFound('Mensagem não encontrada.');
  const body = v.onlyFields(await readJson(request), ['title', 'body', 'active']);
  const changes = {};
  if (body.title !== undefined) changes.title = v.text(body.title, { field: 'o título', min: 2, max: 60 });
  if (body.body !== undefined) changes.body = parseBody(body.body);
  if (body.active !== undefined) changes.active = v.bool(body.active, 'ativa') ? 1 : 0;
  const columns = Object.keys(changes);
  if (!columns.length) throw errors.validation('Nada para alterar.');
  await env.DB.batch([
    env.DB.prepare(`UPDATE message_templates SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND tenant_id = ?`)
      .bind(...columns.map((c) => changes[c]), new Date().toISOString(), current.id, auth.tenantId),
    await auditStatement(env, {
      tenantId: auth.tenantId, actor: actorOf(auth), action: 'TEMPLATE_UPDATED', entity: 'message_template', entityId: current.id,
      details: { title: current.title, fields: columns }, ip,
    }),
  ]);
  const row = await env.DB.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM message_templates WHERE id = ?`).bind(current.id).first();
  return ok(templatePublic(row));
}
