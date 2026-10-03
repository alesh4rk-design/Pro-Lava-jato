// Despesas e custos. Registrar: ADMIN e OPERADOR. Editar e cancelar: só ADMIN.
// Tipo: CUSTO_VARIAVEL (varia com os serviços), DESPESA_FIXA (aluguel, salários...) ou OUTRA.

import { readJson } from './lib/http.js';
import * as v from './lib/validate.js';
import { parseCommon, insertEntry, listEntries, getEntry, findEntry, applyUpdate, cancelEntry } from './entries.js';
import { requireActiveCategory, EXPENSE_TYPES } from './categories.js';

const ledger = {
  table: 'expenses',
  alias: 'e',
  entity: 'expense',
  label: 'Despesa',
  select: `SELECT e.id, e.date, e.category_id, c.name AS category_name, e.type, e.description, e.amount_cents,
                  e.payment_method, e.notes, e.status, e.cancel_reason, e.cancelled_at, cu.name AS cancelled_by_name,
                  u.name AS user_name, e.created_at, e.updated_at
             FROM expenses e
             JOIN users u ON u.id = e.user_id
             JOIN categories c ON c.tenant_id = e.tenant_id AND c.id = e.category_id
             LEFT JOIN users cu ON cu.id = e.cancelled_by`,
  searchColumns: ['e.description', 'e.notes', 'c.name'],
  refFilter: { param: 'category_id', column: 'category_id' },
};

const FIELDS = ['date', 'amount_cents', 'payment_method', 'description', 'notes', 'category_id', 'type'];

export async function createExpense(ctx) {
  const body = v.onlyFields(await readJson(ctx.request), FIELDS);
  const data = parseCommon(body, ctx.env);
  const category = await requireActiveCategory(ctx.env, ctx.auth.tenantId, v.bodyId(body.category_id, 'categoria'), 'DESPESA');
  // Sem tipo informado, vale o padrão da categoria.
  const type = body.type === undefined ? (category.default_expense_type ?? 'OUTRA') : v.oneOf(body.type, EXPENSE_TYPES, 'tipo');
  return await insertEntry(ledger, ctx, { ...data, category_id: category.id, type });
}

export async function updateExpense(ctx) {
  const current = await findEntry(ledger, ctx.env, ctx.auth, ctx.params.id);
  const body = v.onlyFields(await readJson(ctx.request), FIELDS);
  const changes = parseCommon(body, ctx.env, { partial: true });
  if (body.category_id !== undefined) {
    const categoryId = v.bodyId(body.category_id, 'categoria');
    if (categoryId !== current.category_id) {
      changes.category_id = (await requireActiveCategory(ctx.env, ctx.auth.tenantId, categoryId, 'DESPESA')).id;
    }
  }
  if (body.type !== undefined) changes.type = v.oneOf(body.type, EXPENSE_TYPES, 'tipo');
  return await applyUpdate(ledger, ctx, current, changes);
}

export const listExpenses = (ctx) => listEntries(ledger, ctx);
export const getExpense = (ctx) => getEntry(ledger, ctx);
export const cancelExpense = (ctx) => cancelEntry(ledger, ctx);
