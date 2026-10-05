// Configurações do lava-jato. Hoje: nome exibido no topo do app (somente ADMIN altera).

import { ok, readJson, errors } from './lib/http.js';
import * as v from './lib/validate.js';
import { auditStatement, actorOf } from './audit.js';

export async function getSettings({ env, auth }) {
  const tenant = await env.DB.prepare('SELECT business_name, phone FROM tenants WHERE id = ?').bind(auth.tenantId).first();
  return ok({ business_name: tenant.business_name, phone: tenant.phone, timezone: env.TIMEZONE || 'America/Sao_Paulo' });
}

export async function updateSettings({ request, env, auth, ip }) {
  const body = v.onlyFields(await readJson(request), ['business_name', 'phone']);
  const changes = {};
  if (body.business_name !== undefined) changes.business_name = v.text(body.business_name, { field: 'o nome do lava-jato', min: 2, max: 80 });
  if (body.phone !== undefined) changes.phone = v.phone(body.phone);
  const columns = Object.keys(changes);
  if (!columns.length) throw errors.validation('Nada para alterar.');

  const current = await env.DB.prepare('SELECT business_name, phone FROM tenants WHERE id = ?').bind(auth.tenantId).first();
  const changed = columns.filter((c) => changes[c] !== current[c]);
  if (changed.length) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE tenants SET ${changed.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .bind(...changed.map((c) => changes[c]), new Date().toISOString(), auth.tenantId),
      await auditStatement(env, {
        tenantId: auth.tenantId, actor: actorOf(auth), action: 'SETTINGS_CHANGED', entity: 'tenant', entityId: auth.tenantId,
        details: { before: Object.fromEntries(changed.map((c) => [c, current[c]])), after: Object.fromEntries(changed.map((c) => [c, changes[c]])) },
        ip,
      }),
    ]);
  }
  return getSettings({ env, auth });
}
