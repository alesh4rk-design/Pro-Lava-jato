// Primeiros passos do administrador: cada item é marcado sozinho a partir dos dados do lava-jato.

import { ok } from './lib/http.js';

export async function getOnboarding({ env, auth }) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM services WHERE tenant_id = ?1 AND active = 1) AS services,
       (SELECT pix_key <> '' FROM tenants WHERE id = ?1) AS pix,
       (SELECT COUNT(*) FROM customers WHERE tenant_id = ?1) AS customers,
       (SELECT COUNT(*) FROM recurring_expenses WHERE tenant_id = ?1) AS recurring,
       (SELECT COUNT(*) FROM users WHERE tenant_id = ?1 AND role = 'OPERADOR') AS operators,
       (SELECT COALESCE(MAX(enabled), 0) FROM booking_settings WHERE tenant_id = ?1) AS booking,
       (SELECT COUNT(*) FROM revenues WHERE tenant_id = ?1) AS revenues`,
  ).bind(auth.tenantId).first();
  return ok({
    services: row.services > 0,
    pix: row.pix === 1,
    customers: row.customers > 0,
    recurring: row.recurring > 0,
    operator: row.operators > 0,
    booking: row.booking === 1,
    revenue: row.revenues > 0,
  });
}
