// Produtos e insumos, estoque e custo médio.
// Quantidades são inteiras na menor unidade (ML, G, UN). Custo médio em micro-reais por unidade
// (1 real = 1.000.000; 1 centavo = 10.000), atualizado a cada entrada (média ponderada).
// Movimentações: ENTRADA (compra, qty > 0), SAIDA (consumo, qty < 0) e AJUSTE (contagem, ± diferença).
// O estoque nunca fica negativo: a baixa é condicional dentro da própria transação.

import { ok, readJson, errors, ApiError } from './lib/http.js';
import * as v from './lib/validate.js';
import { entryDate, today } from './lib/dates.js';
import { auditStatement, actorOf, LAST_INSERT_ID } from './audit.js';
import { requireActiveCategory } from './categories.js';
import { PAYMENT_METHODS, timeZone } from './entries.js';

export const UNITS = ['ML', 'G', 'UN'];
const MAX_QTY = 1_000_000_000; // 1.000.000 L / kg / un: teto de sanidade por movimentação
const MICRO_PER_CENT = 10_000;

const SELECT = `SELECT p.id, p.name, p.unit, p.category_id, c.name AS category_name, p.stock_qty, p.min_stock_qty,
                       p.avg_cost_micro, p.active, p.updated_at
                  FROM products p LEFT JOIN categories c ON c.tenant_id = p.tenant_id AND c.id = p.category_id`;

/** Custo é informação gerencial: o operador vê estoque, não valores. */
function present(auth, row) {
  const product = { ...row, active: row.active === 1, low_stock: row.stock_qty <= row.min_stock_qty };
  if (auth.role !== 'ADMIN') delete product.avg_cost_micro;
  return product;
}

function presentMovement(auth, row) {
  if (auth.role === 'ADMIN') return row;
  const { unit_cost_micro: _u, total_cost_cents: _t, ...rest } = row;
  return rest;
}

function qty(value, field = 'quantidade', { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_QTY) throw errors.validation(`Campo "${field}" inválido.`);
  return value;
}

async function findProduct(env, auth, idParam) {
  const row = await env.DB.prepare(`${SELECT} WHERE p.tenant_id = ? AND p.id = ?`).bind(auth.tenantId, v.id(idParam)).first();
  if (!row) throw errors.notFound('Produto não encontrado.');
  return row;
}

/* Consulta ------------------------------------------------------------------- */

export async function listProducts({ env, auth, url }) {
  const params = url.searchParams;
  const includeInactive = params.get('include_inactive') === '1' && auth.role === 'ADMIN';
  const lowOnly = params.get('low_stock') === '1';
  const pattern = v.likePattern(params.get('q'));
  const { results } = await env.DB.prepare(
    `${SELECT}
      WHERE p.tenant_id = ?1 AND (?2 = 1 OR p.active = 1) AND (?3 = 0 OR p.stock_qty <= p.min_stock_qty)
        AND (?4 IS NULL OR p.name LIKE ?4 ESCAPE '\\')
      ORDER BY p.active DESC, p.name COLLATE NOCASE LIMIT 500`,
  ).bind(auth.tenantId, includeInactive ? 1 : 0, lowOnly ? 1 : 0, pattern).all();
  return ok({ items: results.map((row) => present(auth, row)) });
}

export async function getProduct({ env, auth, params }) {
  const product = await findProduct(env, auth, params.id);
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.type, m.qty, m.unit_cost_micro, m.total_cost_cents, m.reason, m.created_at, u.name AS user_name,
            e.id AS expense_id
       FROM product_movements m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN expenses e ON e.tenant_id = m.tenant_id AND e.product_movement_id = m.id
      WHERE m.tenant_id = ? AND m.product_id = ?
      ORDER BY m.id DESC LIMIT 30`,
  ).bind(auth.tenantId, product.id).all();
  return ok({ ...present(auth, product), movements: results.map((m) => presentMovement(auth, m)) });
}

/* Cadastro (ADMIN) --------------------------------------------------------------- */

async function optionalCategory(env, auth, value) {
  const categoryId = v.optionalBodyId(value, 'categoria');
  return categoryId === null ? null : (await requireActiveCategory(env, auth.tenantId, categoryId, 'PRODUTO')).id;
}

const duplicate = (error) => String(error?.message).includes('UNIQUE');

export async function createProduct({ request, env, auth, ip }) {
  const body = v.onlyFields(await readJson(request), ['name', 'unit', 'category_id', 'min_stock_qty']);
  const data = {
    name: v.text(body.name, { field: 'o nome', min: 1, max: 60 }),
    unit: v.oneOf(body.unit, UNITS, 'unidade'),
    category_id: await optionalCategory(env, auth, body.category_id),
    min_stock_qty: body.min_stock_qty === undefined ? 0 : qty(body.min_stock_qty, 'estoque mínimo', { allowZero: true }),
  };
  let created;
  try {
    [created] = (await env.DB.batch([
      env.DB.prepare('INSERT INTO products (tenant_id, name, unit, category_id, min_stock_qty) VALUES (?, ?, ?, ?, ?) RETURNING id')
        .bind(auth.tenantId, data.name, data.unit, data.category_id, data.min_stock_qty),
      await auditStatement(env, { tenantId: auth.tenantId, actor: actorOf(auth), action: 'PRODUCT_CREATED', entity: 'product', entityId: LAST_INSERT_ID, details: data, ip }),
    ]))[0].results;
  } catch (error) {
    if (duplicate(error)) throw errors.conflict('Já existe um produto com este nome.');
    throw error;
  }
  return ok(present(auth, await findProduct(env, auth, String(created.id))), 201);
}

export async function updateProduct({ request, env, auth, params, ip }) {
  const current = await findProduct(env, auth, params.id);
  // A unidade não muda depois de criada: alteraria o sentido de todo o estoque e histórico.
  const body = v.onlyFields(await readJson(request), ['name', 'category_id', 'min_stock_qty', 'active']);
  const changes = {};
  if (body.name !== undefined) changes.name = v.text(body.name, { field: 'o nome', min: 1, max: 60 });
  if (body.category_id !== undefined) changes.category_id = await optionalCategory(env, auth, body.category_id);
  if (body.min_stock_qty !== undefined) changes.min_stock_qty = qty(body.min_stock_qty, 'estoque mínimo', { allowZero: true });
  if (body.active !== undefined) changes.active = v.bool(body.active, 'ativo') ? 1 : 0;
  const columns = Object.keys(changes).filter((c) => changes[c] !== current[c]);
  if (!columns.length) return ok(present(auth, current));

  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE products SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND tenant_id = ?`)
        .bind(...columns.map((c) => changes[c]), new Date().toISOString(), current.id, auth.tenantId),
      await auditStatement(env, {
        tenantId: auth.tenantId, actor: actorOf(auth), action: 'PRODUCT_UPDATED', entity: 'product', entityId: current.id,
        details: { before: Object.fromEntries(columns.map((c) => [c, current[c]])), after: Object.fromEntries(columns.map((c) => [c, changes[c]])) },
        ip,
      }),
    ]);
  } catch (error) {
    if (duplicate(error)) throw errors.conflict('Já existe um produto com este nome.');
    throw error;
  }
  return ok(present(auth, await findProduct(env, auth, String(current.id))));
}

/* Movimentações ---------------------------------------------------------------- */

const MOVEMENT_FIELDS = ['type', 'qty', 'counted_qty', 'total_cost_cents', 'reason', 'register_expense', 'payment_method', 'expense_category_id', 'date'];

export async function createMovement(ctx) {
  const { request, env, auth, params } = ctx;
  const product = await findProduct(env, auth, params.id);
  if (!product.active) throw errors.invalidState('Produto desativado.');
  const body = v.onlyFields(await readJson(request), MOVEMENT_FIELDS);
  const type = v.oneOf(body.type, ['ENTRADA', 'SAIDA', 'AJUSTE'], 'tipo');
  const reason = v.optionalText(body.reason, { field: 'motivo', max: 200 });

  if (type === 'ENTRADA') return await purchase(ctx, product, body, reason);
  if (type === 'SAIDA') return await consume(ctx, product, body, reason);
  if (auth.role !== 'ADMIN') throw errors.forbidden();
  return await adjust(ctx, product, body, reason);
}

function movementAudit(ctx, product, details) {
  return auditStatement(ctx.env, {
    tenantId: ctx.auth.tenantId, actor: actorOf(ctx.auth), action: 'PRODUCT_MOVEMENT', entity: 'product', entityId: product.id,
    details: { product: product.name, ...details }, ip: ctx.ip, onlyIfChanged: true,
  });
}

async function respond(ctx, product, status = 201) {
  return ok(present(ctx.auth, await findProduct(ctx.env, ctx.auth, String(product.id))), status);
}

/** Compra: soma ao estoque, recalcula o custo médio e, se pedido, lança a despesa no caixa. */
async function purchase(ctx, product, body, reason) {
  const { env, auth } = ctx;
  const amount = qty(body.qty);
  const totalCents = v.cents(body.total_cost_cents, 'valor pago');
  const totalMicro = totalCents * MICRO_PER_CENT;
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      `UPDATE products SET
         avg_cost_micro = CAST(ROUND((MAX(stock_qty, 0) * avg_cost_micro + ?1) * 1.0 / (MAX(stock_qty, 0) + ?2)) AS INTEGER),
         stock_qty = stock_qty + ?2, updated_at = ?3
       WHERE id = ?4 AND tenant_id = ?5 AND active = 1`,
    ).bind(totalMicro, amount, now, product.id, auth.tenantId),
    env.DB.prepare(
      `INSERT INTO product_movements (tenant_id, product_id, type, qty, unit_cost_micro, total_cost_cents, reason, user_id)
       SELECT ?, ?, 'ENTRADA', ?, ?, ?, ?, ? WHERE changes() > 0`,
    ).bind(auth.tenantId, product.id, amount, Math.round(totalMicro / amount), totalCents, reason, auth.userId),
  ];

  if (body.register_expense === true) {
    const category = await requireActiveCategory(env, auth.tenantId, v.bodyId(body.expense_category_id, 'categoria da despesa'), 'DESPESA');
    const date = body.date === undefined ? today(timeZone(env)) : entryDate(body.date, timeZone(env));
    const method = v.oneOf(body.payment_method, PAYMENT_METHODS, 'forma de pagamento');
    statements.push(
      env.DB.prepare(
        `INSERT INTO expenses (tenant_id, user_id, date, category_id, description, amount_cents, payment_method, type, product_movement_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, 'CUSTO_VARIAVEL', last_insert_rowid() WHERE changes() > 0`,
      ).bind(auth.tenantId, auth.userId, date, category.id, `Compra: ${product.name}`.slice(0, 120), totalCents, method),
      await auditStatement(env, {
        tenantId: auth.tenantId, actor: actorOf(auth), action: 'EXPENSE_CREATED', entity: 'expense', entityId: LAST_INSERT_ID,
        details: { date, amount_cents: totalCents, payment_method: method, product_purchase: product.id }, ip: ctx.ip, onlyIfChanged: true,
      }),
    );
  } else if (body.register_expense !== undefined && body.register_expense !== false) {
    throw errors.validation('Campo "lançar despesa" inválido.');
  }
  statements.push(await movementAudit(ctx, product, { type: 'ENTRADA', qty: amount, total_cost_cents: totalCents, expense: body.register_expense === true }));

  const [update] = await env.DB.batch(statements);
  if (update.meta.changes !== 1) throw errors.invalidState('Produto desativado.');
  return respond(ctx, product);
}

/** Consumo: baixa condicional, nunca deixa o estoque negativo. Custo = quantidade × custo médio. */
async function consume(ctx, product, body, reason) {
  const { env, auth } = ctx;
  const amount = qty(body.qty);
  const [update] = await env.DB.batch([
    env.DB.prepare('UPDATE products SET stock_qty = stock_qty - ?1, updated_at = ?2 WHERE id = ?3 AND tenant_id = ?4 AND active = 1 AND stock_qty >= ?1')
      .bind(amount, new Date().toISOString(), product.id, auth.tenantId),
    env.DB.prepare(
      `INSERT INTO product_movements (tenant_id, product_id, type, qty, unit_cost_micro, total_cost_cents, reason, user_id)
       SELECT tenant_id, id, 'SAIDA', -?1, avg_cost_micro, -CAST(ROUND(?1 * avg_cost_micro / 10000.0) AS INTEGER), ?2, ?3
         FROM products WHERE id = ?4 AND tenant_id = ?5 AND changes() > 0`,
    ).bind(amount, reason, auth.userId, product.id, auth.tenantId),
    await movementAudit(ctx, product, { type: 'SAIDA', qty: -amount }),
  ]);
  if (update.meta.changes !== 1) {
    throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Estoque insuficiente. Registre a compra ou faça um ajuste de estoque.');
  }
  return respond(ctx, product);
}

/** Ajuste por contagem (ADMIN): define o estoque contado e registra a diferença. */
async function adjust(ctx, product, body, reason) {
  const { env, auth } = ctx;
  const counted = qty(body.counted_qty, 'quantidade contada', { allowZero: true });
  if (!reason) throw errors.validation('Informe o motivo do ajuste.');
  const diff = counted - product.stock_qty;
  if (diff === 0) throw errors.invalidState('O estoque já está com esta quantidade.');

  // Concorrência otimista: só ajusta se o estoque ainda é o que foi lido.
  const [update] = await env.DB.batch([
    env.DB.prepare('UPDATE products SET stock_qty = ?1, updated_at = ?2 WHERE id = ?3 AND tenant_id = ?4 AND stock_qty = ?5')
      .bind(counted, new Date().toISOString(), product.id, auth.tenantId, product.stock_qty),
    env.DB.prepare(
      `INSERT INTO product_movements (tenant_id, product_id, type, qty, unit_cost_micro, total_cost_cents, reason, user_id)
       SELECT tenant_id, id, 'AJUSTE', ?1, avg_cost_micro, CAST(ROUND(?1 * avg_cost_micro / 10000.0) AS INTEGER), ?2, ?3
         FROM products WHERE id = ?4 AND tenant_id = ?5 AND changes() > 0`,
    ).bind(diff, reason, auth.userId, product.id, auth.tenantId),
    await movementAudit(ctx, product, { type: 'AJUSTE', from: product.stock_qty, to: counted, reason }),
  ]);
  if (update.meta.changes !== 1) throw errors.invalidState('O estoque mudou enquanto você ajustava. Confira e tente de novo.');
  return respond(ctx, product);
}
