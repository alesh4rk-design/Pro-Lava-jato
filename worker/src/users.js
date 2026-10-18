// Usuários do lava-jato (somente ADMIN). Toda consulta é filtrada por tenant_id da sessão.

import { ok, readJson, errors } from './lib/http.js';
import * as v from './lib/validate.js';
import { verifyFirebaseToken } from './lib/firebase.js';
import { ROLES } from './middleware.js';
import { auditStatement, actorOf } from './audit.js';

const PUBLIC_FIELDS = 'id, name, email, role, active, last_login_at, created_at';
const toPublic = (row) => ({ ...row, active: row.active === 1 });

async function findUser(env, auth, idParam) {
  const row = await env.DB.prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ? AND tenant_id = ?`)
    .bind(v.id(idParam), auth.tenantId).first();
  if (!row) throw errors.notFound('Usuário não encontrado.');
  return row;
}

const revokeSessions = (env, userId, now) =>
  env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, userId);

export async function listUsers({ env, auth }) {
  const { results } = await env.DB.prepare(
    `SELECT ${PUBLIC_FIELDS} FROM users WHERE tenant_id = ? ORDER BY active DESC, name COLLATE NOCASE LIMIT 200`,
  ).bind(auth.tenantId).all();
  return ok({ items: results.map(toPublic) });
}

export async function createUser({ request, env, auth, ip }) {
  const body = v.onlyFields(await readJson(request), ['name', 'id_token', 'role']);
  const data = {
    name: v.text(body.name, { field: 'o nome', min: 2, max: 80 }),
    role: v.oneOf(body.role, Object.values(ROLES), 'perfil'),
  };

  // A conta (e-mail e senha) foi criada no Firebase pelo navegador do administrador; o token a identifica.
  const identity = await verifyFirebaseToken(env, body.id_token);
  data.email = identity.email;

  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ? OR firebase_uid = ?').bind(data.email, identity.uid).first();
  if (exists) throw errors.conflict('Este e-mail já está em uso.');

  const created = await env.DB.prepare(
    `INSERT INTO users (tenant_id, name, email, password_hash, firebase_uid, role) VALUES (?, ?, ?, 'firebase', ?, ?) RETURNING ${PUBLIC_FIELDS}`,
  ).bind(auth.tenantId, data.name, data.email, identity.uid, data.role).first();

  await (await auditStatement(env, {
    tenantId: auth.tenantId, actor: actorOf(auth), action: 'USER_CREATED', entity: 'user', entityId: created.id,
    details: { name: data.name, email: data.email, role: data.role }, ip,
  })).run();
  return ok(toPublic(created), 201);
}

async function countOtherActiveAdmins(env, auth, userId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = 'ADMIN' AND active = 1 AND id <> ?`,
  ).bind(auth.tenantId, userId).first();
  return row.n;
}

export async function updateUser({ request, env, auth, params, ip }) {
  const user = await findUser(env, auth, params.id);
  const body = v.onlyFields(await readJson(request), ['name', 'role', 'active']);
  const changes = {};
  if (body.name !== undefined) changes.name = v.text(body.name, { field: 'o nome', min: 2, max: 80 });
  if (body.role !== undefined) changes.role = v.oneOf(body.role, Object.values(ROLES), 'perfil');
  if (body.active !== undefined) changes.active = v.bool(body.active, 'ativo') ? 1 : 0;
  if (!Object.keys(changes).length) throw errors.validation('Nada para alterar.');

  const roleChanged = changes.role !== undefined && changes.role !== user.role;
  const deactivated = changes.active === 0 && user.active === 1;

  if (user.id === auth.userId && (roleChanged || deactivated)) {
    throw errors.invalidState('Você não pode alterar o próprio perfil nem desativar a si mesmo.');
  }
  const losesAdmin = user.role === 'ADMIN' && user.active === 1 && ((roleChanged && changes.role !== 'ADMIN') || deactivated);
  if (losesAdmin && (await countOtherActiveAdmins(env, auth, user.id)) === 0) {
    throw errors.invalidState('O lava-jato precisa ter pelo menos um administrador ativo.');
  }

  const now = new Date().toISOString();
  const columns = Object.keys(changes);
  const statements = [
    env.DB.prepare(`UPDATE users SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND tenant_id = ?`)
      .bind(...columns.map((c) => changes[c]), now, user.id, auth.tenantId),
    await auditStatement(env, {
      tenantId: auth.tenantId,
      actor: actorOf(auth),
      action: roleChanged ? 'PERMISSION_CHANGED' : 'USER_UPDATED',
      entity: 'user',
      entityId: user.id,
      details: { before: { name: user.name, role: user.role, active: user.active === 1 }, changes },
      ip,
    }),
  ];
  // Mudança de perfil ou desativação vale imediatamente: derruba as sessões abertas.
  if (roleChanged || deactivated) statements.push(revokeSessions(env, user.id, now));
  await env.DB.batch(statements);

  return ok(toPublic({ ...user, ...changes }));
}

/**
 * O e-mail de redefinição é enviado pelo Firebase (o navegador chama o Firebase); a senha nunca passa por aqui.
 * Esta rota confere que o usuário é do lava-jato, registra o pedido na auditoria e devolve o e-mail.
 */
export async function resetUserPassword({ env, auth, params, ip }) {
  const user = await findUser(env, auth, params.id);
  if (user.id === auth.userId) throw errors.invalidState('Para trocar a sua senha, use "Minha conta".');
  await (await auditStatement(env, { tenantId: auth.tenantId, actor: actorOf(auth), action: 'PASSWORD_RESET', entity: 'user', entityId: user.id, ip })).run();
  return ok({ email: user.email });
}
