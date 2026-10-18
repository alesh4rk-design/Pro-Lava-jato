// Usuários do lava-jato (somente ADMIN). Toda consulta é filtrada por tenant_id da sessão.

import { ok, readJson, errors } from './lib/http.js';
import * as v from './lib/validate.js';
import { verifyFirebaseToken } from './lib/firebase.js';
import { auditStatement, actorOf } from './audit.js';

// Regra do negócio: o administrador é quem pediu o acesso e ninguém é promovido a administrador.
// Cada lava-jato pode ter no máximo 2 operadores ativos (desativar um libera a vaga).
export const MAX_OPERATORS = 2;
const LIMIT_MESSAGE = `Limite de ${MAX_OPERATORS} operadores atingido. Desative um operador para cadastrar ou reativar outro.`;
const ACTIVE_OPERATORS = "(SELECT COUNT(*) FROM users WHERE tenant_id = ?1 AND role = 'OPERADOR' AND active = 1)";

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
  const items = results.map(toPublic);
  const active = items.filter((u) => u.role === 'OPERADOR' && u.active).length;
  return ok({ items, limits: { operators_max: MAX_OPERATORS, operators_active: active } });
}

export async function createUser({ request, env, auth, ip }) {
  // Só operador: quem quiser outro administrador não existe neste sistema (perfil "ADMIN" é recusado).
  const body = v.onlyFields(await readJson(request), ['name', 'id_token', 'role']);
  if (body.role !== undefined && body.role !== 'OPERADOR') throw errors.validation('Só é possível cadastrar operadores.');
  const data = { name: v.text(body.name, { field: 'o nome', min: 2, max: 80 }), role: 'OPERADOR' };

  // A conta (e-mail e senha) foi criada no Firebase pelo navegador do administrador; o token a identifica.
  const identity = await verifyFirebaseToken(env, body.id_token);
  data.email = identity.email;

  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ? OR firebase_uid = ?').bind(data.email, identity.uid).first();
  if (exists) throw errors.conflict('Este e-mail já está em uso.');

  // O limite é conferido dentro do próprio INSERT: dois cadastros ao mesmo tempo não passam de 2 operadores.
  const created = await env.DB.prepare(
    `INSERT INTO users (tenant_id, name, email, password_hash, firebase_uid, role)
     SELECT ?1, ?2, ?3, 'firebase', ?4, 'OPERADOR' WHERE ${ACTIVE_OPERATORS} < ${MAX_OPERATORS}
     RETURNING ${PUBLIC_FIELDS}`,
  ).bind(auth.tenantId, data.name, data.email, identity.uid).first();
  if (!created) throw errors.conflict(LIMIT_MESSAGE);

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
  // O perfil não muda: não existe promoção a administrador nem rebaixamento.
  const body = v.onlyFields(await readJson(request), ['name', 'active']);
  const changes = {};
  if (body.name !== undefined) changes.name = v.text(body.name, { field: 'o nome', min: 2, max: 80 });
  if (body.active !== undefined) changes.active = v.bool(body.active, 'ativo') ? 1 : 0;
  if (!Object.keys(changes).length) throw errors.validation('Nada para alterar.');

  const deactivated = changes.active === 0 && user.active === 1;
  const reactivated = changes.active === 1 && user.active === 0;

  if (user.id === auth.userId && deactivated) throw errors.invalidState('Você não pode desativar a si mesmo.');
  if (user.role === 'ADMIN' && user.active === 1 && deactivated && (await countOtherActiveAdmins(env, auth, user.id)) === 0) {
    throw errors.invalidState('O lava-jato precisa ter pelo menos um administrador ativo.');
  }

  const now = new Date().toISOString();
  const columns = Object.keys(changes);
  // Reativar operador respeita o limite, conferido no próprio UPDATE (vale também com pedidos simultâneos).
  const guard = reactivated && user.role === 'OPERADOR' ? ` AND ${ACTIVE_OPERATORS.replace('?1', '?')} < ${MAX_OPERATORS}` : '';
  const binds = [...columns.map((c) => changes[c]), now, user.id, auth.tenantId, ...(guard ? [auth.tenantId] : [])];
  const statements = [
    env.DB.prepare(`UPDATE users SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND tenant_id = ?${guard}`).bind(...binds),
    await auditStatement(env, {
      tenantId: auth.tenantId, actor: actorOf(auth), action: 'USER_UPDATED', entity: 'user', entityId: user.id,
      details: { before: { name: user.name, active: user.active === 1 }, changes }, ip, onlyIfChanged: true,
    }),
  ];
  // Desativação vale imediatamente: derruba as sessões abertas.
  if (deactivated) statements.push(revokeSessions(env, user.id, now));
  const [update] = await env.DB.batch(statements);
  if (update.meta.changes !== 1) throw errors.conflict(LIMIT_MESSAGE);

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
