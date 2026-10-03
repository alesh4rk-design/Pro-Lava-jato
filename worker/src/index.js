// Ponto de entrada do Worker: CORS, roteamento, autenticação/RBAC e tratamento seguro de erros.

import { ok, fail, errors, ApiError } from './lib/http.js';
import { corsHeaders, assertOrigin, authenticateTenant, authenticateSystem, requireRole, clientIp, ROLES } from './middleware.js';
import * as authRoutes from './auth.js';
import * as users from './users.js';
import * as system from './system.js';

const { ADMIN, OPERADOR } = ROLES;
const PUBLIC = null;
const TENANT = 'tenant';
const SYSTEM = 'system';

/**
 * Tabela de rotas: [método, caminho, escopo de autenticação, perfis permitidos, handler].
 * Perfis vazios = qualquer usuário autenticado do escopo.
 */
const ROUTES = [
  ['GET', '/api/health', PUBLIC, [], () => ok({ status: 'ok' })],

  ['POST', '/api/auth/login', PUBLIC, [], authRoutes.tenantLogin],
  ['POST', '/api/auth/logout', TENANT, [], authRoutes.logout],
  ['GET', '/api/auth/me', TENANT, [], authRoutes.me],
  ['POST', '/api/auth/password', TENANT, [], authRoutes.changePassword],
  ['POST', '/api/access-requests', PUBLIC, [], authRoutes.requestAccess],

  ['GET', '/api/users', TENANT, [ADMIN], users.listUsers],
  ['POST', '/api/users', TENANT, [ADMIN], users.createUser],
  ['PUT', '/api/users/:id', TENANT, [ADMIN], users.updateUser],
  ['POST', '/api/users/:id/password', TENANT, [ADMIN], users.resetUserPassword],

  ['POST', '/api/system/auth/login', PUBLIC, [], authRoutes.systemLogin],
  ['POST', '/api/system/auth/logout', SYSTEM, [], authRoutes.logout],
  ['GET', '/api/system/tenants', SYSTEM, [], system.listTenants],
  ['POST', '/api/system/tenants/:id/:action', SYSTEM, [], system.changeTenantStatus],
].map(([method, path, scope, roles, handler]) => ({
  method,
  scope,
  roles,
  handler,
  keys: [...path.matchAll(/:(\w+)/g)].map((m) => m[1]),
  pattern: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`),
}));

// Rotas TENANT sem perfis explícitos aceitam os dois perfis de lava-jato.
const TENANT_ROLES = [ADMIN, OPERADOR];

function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw errors.notFound();
  }
}

function matchRoute(method, pathname) {
  let pathExists = false;
  for (const route of ROUTES) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    pathExists = true;
    if (route.method === method) {
      const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeParam(match[i + 1])]));
      return { route, params };
    }
  }
  if (pathExists) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
  throw errors.notFound();
}

async function handle(request, env) {
  assertOrigin(request, env);
  const url = new URL(request.url);
  const { route, params } = matchRoute(request.method, url.pathname);

  let auth = null;
  if (route.scope === TENANT) {
    auth = await authenticateTenant(request, env);
    requireRole(auth, ...(route.roles.length ? route.roles : TENANT_ROLES));
  } else if (route.scope === SYSTEM) {
    auth = await authenticateSystem(request, env);
  }

  return await route.handler({ request, env, url, params, auth, ip: clientIp(request) });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });
    }

    let response;
    try {
      response = await handle(request, env);
    } catch (error) {
      if (error instanceof ApiError) {
        response = fail(error);
      } else {
        // Detalhes ficam só no log do Worker; o cliente recebe mensagem genérica.
        console.error('Unhandled error', { path: new URL(request.url).pathname, message: error?.message });
        response = fail(errors.internal());
      }
    }

    if (cors) Object.entries(cors).forEach(([key, value]) => response.headers.set(key, value));
    return response;
  },
};
