// Configurações do lava-jato (somente ADMIN): nome exibido no topo do app, telefone e chave PIX para cobrança.

import { ok, readJson, errors } from './lib/http.js';
import * as v from './lib/validate.js';
import { normalizePixKey, maskPixKey, PIX_TYPES } from './lib/pix.js';
import { auditStatement, actorOf } from './audit.js';

const COLUMNS = 'business_name, phone, pix_key, pix_key_type, pix_holder';

async function current(env, tenantId) {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM tenants WHERE id = ?`).bind(tenantId).first();
}

export async function getSettings({ env, auth }) {
  const tenant = await current(env, auth.tenantId);
  return ok({ ...tenant, timezone: env.TIMEZONE || 'America/Sao_Paulo' });
}

/** Chave e tipo andam juntos: ou os dois preenchidos e válidos, ou os dois vazios (remove a chave). */
function parsePix(body, before) {
  const keyGiven = body.pix_key !== undefined;
  const typeGiven = body.pix_key_type !== undefined;
  if (!keyGiven && !typeGiven) return {};
  const key = keyGiven ? body.pix_key : before.pix_key;
  const type = typeGiven ? body.pix_key_type : before.pix_key_type;
  if (keyGiven && typeof key === 'string' && key.trim() === '') return { pix_key: '', pix_key_type: '', pix_holder: body.pix_holder === undefined ? '' : undefined };
  if (!keyGiven && !before.pix_key) throw errors.validation('Informe a chave PIX.');
  if (!PIX_TYPES.includes(type)) throw errors.validation('Escolha o tipo da chave PIX.');
  return { pix_key: normalizePixKey(type, key), pix_key_type: type };
}

export async function updateSettings({ request, env, auth, ip }) {
  const body = v.onlyFields(await readJson(request), ['business_name', 'phone', 'pix_key', 'pix_key_type', 'pix_holder']);
  const before = await current(env, auth.tenantId);
  const changes = {};
  if (body.business_name !== undefined) changes.business_name = v.text(body.business_name, { field: 'o nome do lava-jato', min: 2, max: 80 });
  if (body.phone !== undefined) changes.phone = v.phone(body.phone);
  Object.assign(changes, parsePix(body, before));
  if (body.pix_holder !== undefined) changes.pix_holder = v.optionalText(body.pix_holder, { field: 'o nome do recebedor', max: 60 });
  for (const key of Object.keys(changes)) if (changes[key] === undefined) delete changes[key];
  const columns = Object.keys(changes);
  if (!columns.length) throw errors.validation('Nada para alterar.');

  const changed = columns.filter((c) => changes[c] !== before[c]);
  if (changed.length) {
    // A auditoria mostra que a chave PIX mudou, quando e por quem, mas guarda só o final dela.
    const show = (row, c) => (c === 'pix_key' ? maskPixKey(row[c]) : row[c]);
    await env.DB.batch([
      env.DB.prepare(`UPDATE tenants SET ${changed.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .bind(...changed.map((c) => changes[c]), new Date().toISOString(), auth.tenantId),
      await auditStatement(env, {
        tenantId: auth.tenantId, actor: actorOf(auth), action: 'SETTINGS_CHANGED', entity: 'tenant', entityId: auth.tenantId,
        details: { before: Object.fromEntries(changed.map((c) => [c, show(before, c)])), after: Object.fromEntries(changed.map((c) => [c, show(changes, c)])) },
        ip,
      }),
    ]);
  }
  return getSettings({ env, auth });
}
