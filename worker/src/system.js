// Administração da plataforma (somente administrador do sistema):
// listar lava-jatos e autorizar, bloquear ou desbloquear acessos.

import { ok, errors } from './lib/http.js';
import * as v from './lib/validate.js';
import { auditStatement, actorOf } from './audit.js';

const STATUSES = ['PENDENTE', 'ATIVO', 'BLOQUEADO'];
const PAGE_SIZE = 50;

export async function listTenants({ env, url }) {
  const status = url.searchParams.get('status') || null;
  if (status !== null) v.oneOf(status, STATUSES, 'situação');
  const pageParam = url.searchParams.get('page') ?? '1';
  const page = /^[1-9]\d{0,4}$/.test(pageParam) ? Number(pageParam) : 1;

  const [list, counts] = await env.DB.batch([
    env.DB.prepare(
      `SELECT t.id, t.business_name, t.phone, t.status, t.created_at, u.name AS owner_name, u.email
         FROM tenants t
         LEFT JOIN users u ON u.id = (SELECT MIN(id) FROM users WHERE tenant_id = t.id AND role = 'ADMIN')
        WHERE (?1 IS NULL OR t.status = ?1)
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ?2 OFFSET ?3`,
    ).bind(status, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE),
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM tenants GROUP BY status'),
  ]);

  const countMap = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  counts.results.forEach((row) => { countMap[row.status] = row.n; });
  return ok({
    items: list.results.slice(0, PAGE_SIZE),
    counts: countMap,
    page,
    has_more: list.results.length > PAGE_SIZE,
  });
}

const TRANSITIONS = {
  approve: { from: ['PENDENTE'], to: 'ATIVO', action: 'TENANT_APPROVED' },
  block: { from: ['PENDENTE', 'ATIVO'], to: 'BLOQUEADO', action: 'TENANT_BLOCKED' },
  unblock: { from: ['BLOQUEADO'], to: 'ATIVO', action: 'TENANT_UNBLOCKED' },
};

export async function changeTenantStatus({ env, auth, params, ip }) {
  const transition = TRANSITIONS[params.action];
  if (!transition) throw errors.notFound();
  const tenantId = v.id(params.id);

  const tenant = await env.DB.prepare('SELECT id, business_name, status FROM tenants WHERE id = ?').bind(tenantId).first();
  if (!tenant) throw errors.notFound('Cliente não encontrado.');
  if (!transition.from.includes(tenant.status)) throw errors.invalidState();

  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      `UPDATE tenants SET status = ?1, updated_at = ?2,
         approved_by = CASE WHEN ?3 = 'approve' THEN ?4 ELSE approved_by END,
         approved_at = CASE WHEN ?3 = 'approve' THEN ?2 ELSE approved_at END,
         blocked_at  = CASE WHEN ?1 = 'BLOQUEADO' THEN ?2 ELSE NULL END
       WHERE id = ?5 AND status = ?6`,
    ).bind(transition.to, now, params.action, auth.adminId, tenantId, tenant.status),
    await auditStatement(env, {
      tenantId, actor: actorOf(auth), action: transition.action, entity: 'tenant', entityId: tenantId,
      details: { business_name: tenant.business_name, from: tenant.status, to: transition.to }, ip,
    }),
  ];
  // Bloqueio desconecta imediatamente todos os usuários do lava-jato.
  if (transition.to === 'BLOQUEADO') {
    statements.push(env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL').bind(now, tenantId));
  }
  const [update] = await env.DB.batch(statements);
  if (update.meta.changes !== 1) throw errors.invalidState();

  return ok({ ...tenant, status: transition.to });
}
