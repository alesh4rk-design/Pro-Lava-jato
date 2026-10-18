// "Meu dia": o que a própria pessoa lançou hoje. É tudo que o operador enxerga dos lançamentos:
// nada de totais do lava-jato, saldo, histórico nem lançamentos de outras pessoas.

import { ok } from './lib/http.js';
import { today } from './lib/dates.js';
import { timeZone } from './entries.js';

const LIMIT = 100;

export async function getMyDay({ env, auth }) {
  const date = today(timeZone(env));
  const [revenues, expenses] = await env.DB.batch([
    env.DB.prepare(
      `SELECT r.id, r.amount_cents, r.payment_method, r.description, s.name AS label, r.created_at
         FROM revenues r LEFT JOIN services s ON s.tenant_id = r.tenant_id AND s.id = r.service_id
        WHERE r.tenant_id = ? AND r.user_id = ? AND r.date = ? AND r.status = 'ATIVO'
        ORDER BY r.id DESC LIMIT ?`,
    ).bind(auth.tenantId, auth.userId, date, LIMIT),
    env.DB.prepare(
      `SELECT e.id, e.amount_cents, e.payment_method, e.description, c.name AS label, e.created_at
         FROM expenses e JOIN categories c ON c.tenant_id = e.tenant_id AND c.id = e.category_id
        WHERE e.tenant_id = ? AND e.user_id = ? AND e.date = ? AND e.status = 'ATIVO'
        ORDER BY e.id DESC LIMIT ?`,
    ).bind(auth.tenantId, auth.userId, date, LIMIT),
  ]);
  const item = (kind) => (row) => ({
    kind, id: row.id, title: row.description || row.label || (kind === 'IN' ? 'Receita' : 'Despesa'),
    amount_cents: row.amount_cents, payment_method: row.payment_method, created_at: row.created_at,
  });
  const items = [...revenues.results.map(item('IN')), ...expenses.results.map(item('OUT'))]
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  return ok({
    date,
    items,
    revenue_count: revenues.results.length,
    expense_count: expenses.results.length,
  });
}
