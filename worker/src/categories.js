// Categorias de despesas e de produtos. Leitura para qualquer usuário do lava-jato; escrita só ADMIN.
// Categorias não são apagadas (lançamentos antigos apontam para elas): são desativadas.

import { ok, readJson, errors } from './lib/http.js';
import * as v from './lib/validate.js';
import { auditStatement, actorOf } from './audit.js';

export const KINDS = ['DESPESA', 'PRODUTO'];
export const EXPENSE_TYPES = ['CUSTO_VARIAVEL', 'DESPESA_FIXA', 'OUTRA'];

const DEFAULTS = [
  ['Aluguel', 'DESPESA', 'DESPESA_FIXA'],
  ['Energia', 'DESPESA', 'DESPESA_FIXA'],
  ['Água', 'DESPESA', 'DESPESA_FIXA'],
  ['Internet e telefone', 'DESPESA', 'DESPESA_FIXA'],
  ['Funcionários', 'DESPESA', 'DESPESA_FIXA'],
  ['Contabilidade', 'DESPESA', 'DESPESA_FIXA'],
  ['Produtos e materiais', 'DESPESA', 'CUSTO_VARIAVEL'],
  ['Manutenção', 'DESPESA', 'OUTRA'],
  ['Marketing', 'DESPESA', 'OUTRA'],
  ['Impostos e taxas', 'DESPESA', 'OUTRA'],
  ['Shampoo', 'PRODUTO', null],
  ['Cera', 'PRODUTO', null],
  ['Detergente', 'PRODUTO', null],
  ['Desengraxante', 'PRODUTO', null],
  ['Panos e esponjas', 'PRODUTO', null],
];

/** Statement que cria as categorias padrão de um novo lava-jato. */
export function seedDefaultCategories(env, tenantId) {
  const values = DEFAULTS.map(() => '(?, ?, ?, ?)').join(', ');
  return env.DB.prepare(`INSERT INTO categories (tenant_id, name, kind, default_expense_type) VALUES ${values}`)
    .bind(...DEFAULTS.flatMap(([name, kind, type]) => [tenantId, name, kind, type]));
}

const FIELDS = 'id, name, kind, default_expense_type, active';
const toPublic = (row) => ({ ...row, active: row.active === 1 });

export async function listCategories({ env, auth, url }) {
  const kind = url.searchParams.get('kind');
  if (kind !== null) v.oneOf(kind, KINDS, 'tipo');
  // Inativas só aparecem para ADMIN, na tela de cadastro.
  const includeInactive = url.searchParams.get('include_inactive') === '1' && auth.role === 'ADMIN';

  const { results } = await env.DB.prepare(
    `SELECT ${FIELDS} FROM categories
      WHERE tenant_id = ?1 AND (?2 IS NULL OR kind = ?2) AND (?3 = 1 OR active = 1)
      ORDER BY active DESC, name COLLATE NOCASE LIMIT 500`,
  ).bind(auth.tenantId, kind, includeInactive ? 1 : 0).all();
  return ok({ items: results.map(toPublic) });
}

function parseFields(body, { partial }) {
  const data = {};
  if (!partial || body.name !== undefined) data.name = v.text(body.name, { field: 'o nome', min: 1, max: 60 });
  if (!partial || body.kind !== undefined) data.kind = v.oneOf(body.kind, KINDS, 'tipo');
  if (body.default_expense_type !== undefined) {
    data.default_expense_type = body.default_expense_type === null ? null : v.oneOf(body.default_expense_type, EXPENSE_TYPES, 'tipo de despesa');
  }
  if (body.active !== undefined) data.active = v.bool(body.active, 'ativa') ? 1 : 0;
  return data;
}

const duplicate = (error) => String(error?.message).includes('UNIQUE');

export async function createCategory({ request, env, auth, ip }) {
  const body = v.onlyFields(await readJson(request), ['name', 'kind', 'default_expense_type']);
  const data = parseFields(body, { partial: false });
  if (data.kind === 'PRODUTO') data.default_expense_type = null;

  let created;
  try {
    created = await env.DB.prepare(
      `INSERT INTO categories (tenant_id, name, kind, default_expense_type) VALUES (?, ?, ?, ?) RETURNING ${FIELDS}`,
    ).bind(auth.tenantId, data.name, data.kind, data.default_expense_type ?? null).first();
  } catch (error) {
    if (duplicate(error)) throw errors.conflict('Já existe uma categoria com este nome.');
    throw error;
  }
  await (await auditStatement(env, {
    tenantId: auth.tenantId, actor: actorOf(auth), action: 'CATEGORY_CREATED', entity: 'category', entityId: created.id, details: data, ip,
  })).run();
  return ok(toPublic(created), 201);
}

export async function updateCategory({ request, env, auth, params, ip }) {
  const id = v.id(params.id);
  const current = await env.DB.prepare(`SELECT ${FIELDS} FROM categories WHERE id = ? AND tenant_id = ?`).bind(id, auth.tenantId).first();
  if (!current) throw errors.notFound('Categoria não encontrada.');

  const body = v.onlyFields(await readJson(request), ['name', 'default_expense_type', 'active']);
  const changes = parseFields(body, { partial: true });
  if (current.kind === 'PRODUTO') delete changes.default_expense_type;
  const columns = Object.keys(changes);
  if (!columns.length) throw errors.validation('Nada para alterar.');

  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE categories SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND tenant_id = ?`)
        .bind(...columns.map((c) => changes[c]), new Date().toISOString(), id, auth.tenantId),
      await auditStatement(env, {
        tenantId: auth.tenantId, actor: actorOf(auth), action: 'CATEGORY_UPDATED', entity: 'category', entityId: id,
        details: { before: current, changes }, ip,
      }),
    ]);
  } catch (error) {
    if (duplicate(error)) throw errors.conflict('Já existe uma categoria com este nome.');
    throw error;
  }
  return ok(toPublic({ ...current, ...changes }));
}

/** Categoria ativa do lava-jato e do tipo esperado; usada ao validar lançamentos. */
export async function requireActiveCategory(env, tenantId, categoryId, kind) {
  const row = await env.DB.prepare(`SELECT ${FIELDS} FROM categories WHERE id = ? AND tenant_id = ? AND kind = ? AND active = 1`)
    .bind(categoryId, tenantId, kind).first();
  if (!row) throw errors.validation('Categoria inválida.');
  return row;
}
