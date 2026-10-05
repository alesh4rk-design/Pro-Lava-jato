// Ponto de entrada do Worker: CORS, roteamento, autenticação/RBAC e tratamento seguro de erros.

import { ok, fail, errors, ApiError } from './lib/http.js';
import { corsHeaders, assertOrigin, authenticateTenant, authenticateSystem, requireRole, rateLimit, clientIp, ROLES } from './middleware.js';
import { listTenantAudit, listSystemAudit } from './audit.js';
import { cleanup } from './maintenance.js';
import * as authRoutes from './auth.js';
import * as users from './users.js';
import * as system from './system.js';
import * as categories from './categories.js';
import * as services from './services.js';
import * as products from './products.js';
import * as revenues from './revenues.js';
import * as expenses from './expenses.js';
import * as cash from './cash.js';
import * as dashboard from './dashboard.js';
import * as reports from './reports.js';
import * as settings from './settings.js';

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

  ['GET', '/api/dashboard', TENANT, [], dashboard.getDashboard],
  ['GET', '/api/audit', TENANT, [ADMIN], listTenantAudit],
  ['GET', '/api/settings', TENANT, [ADMIN], settings.getSettings],
  ['PUT', '/api/settings', TENANT, [ADMIN], settings.updateSettings],

  ['GET', '/api/reports/financial', TENANT, [ADMIN], reports.financialReport],
  ['GET', '/api/reports/categories', TENANT, [ADMIN], reports.categoriesReport],
  ['GET', '/api/reports/services', TENANT, [ADMIN], reports.servicesReport],
  ['GET', '/api/reports/break-even', TENANT, [ADMIN], reports.breakEvenReport],

  ['GET', '/api/categories', TENANT, [], categories.listCategories],
  ['POST', '/api/categories', TENANT, [ADMIN], categories.createCategory],
  ['PUT', '/api/categories/:id', TENANT, [ADMIN], categories.updateCategory],

  ['GET', '/api/services', TENANT, [], services.listServices],
  ['POST', '/api/services', TENANT, [ADMIN], services.createService],
  ['GET', '/api/services/:id', TENANT, [], services.getService],
  ['PUT', '/api/services/:id', TENANT, [ADMIN], services.updateService],
  ['PUT', '/api/services/:id/costs', TENANT, [ADMIN], services.replaceServiceCosts],

  ['GET', '/api/products', TENANT, [], products.listProducts],
  ['POST', '/api/products', TENANT, [ADMIN], products.createProduct],
  ['GET', '/api/products/:id', TENANT, [], products.getProduct],
  ['PUT', '/api/products/:id', TENANT, [ADMIN], products.updateProduct],
  // Compra e consumo: ADMIN e OPERADOR; ajuste (AJUSTE) é conferido como só ADMIN no handler.
  ['POST', '/api/products/:id/movements', TENANT, [ADMIN, OPERADOR], products.createMovement],

  ['GET', '/api/revenues', TENANT, [], revenues.listRevenues],
  ['POST', '/api/revenues', TENANT, [ADMIN, OPERADOR], revenues.createRevenue],
  ['GET', '/api/revenues/:id', TENANT, [], revenues.getRevenue],
  ['PUT', '/api/revenues/:id', TENANT, [ADMIN], revenues.updateRevenue],
  ['DELETE', '/api/revenues/:id', TENANT, [ADMIN], revenues.cancelRevenue],

  ['GET', '/api/expenses', TENANT, [], expenses.listExpenses],
  ['POST', '/api/expenses', TENANT, [ADMIN, OPERADOR], expenses.createExpense],
  ['GET', '/api/expenses/:id', TENANT, [], expenses.getExpense],
  ['PUT', '/api/expenses/:id', TENANT, [ADMIN], expenses.updateExpense],
  ['DELETE', '/api/expenses/:id', TENANT, [ADMIN], expenses.cancelExpense],

  ['GET', '/api/cash', TENANT, [], cash.cashSummary],
  ['GET', '/api/cash/entries', TENANT, [], cash.cashEntries],

  ['POST', '/api/system/auth/login', PUBLIC, [], authRoutes.systemLogin],
  ['POST', '/api/system/auth/logout', SYSTEM, [], authRoutes.logout],
  ['GET', '/api/system/tenants', SYSTEM, [], system.listTenants],
  ['GET', '/api/system/audit', SYSTEM, [], listSystemAudit],
  ['POST', '/api/system/tenants/:id/:action', SYSTEM, [], system.changeTenantStatus],
].map(([method, path, scope, roles, handler]) => ({
  method,
  scope,
  roles,
  handler,
  keys: [...path.matchAll(/:(\w+)/g)].map((m) => m[1]),
  pattern: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`),
}));

const WRITE_LIMIT_PER_MINUTE = 120;

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

  // Limite de gravações por usuário: folgado para uso normal, contém scripts abusivos.
  if (auth && request.method !== 'GET') {
    await rateLimit(env, `write:${auth.scope}:${auth.userId ?? auth.adminId}`, WRITE_LIMIT_PER_MINUTE, 60);
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

  /** Rotina diária (Cron Trigger): remove sessões vencidas e contadores de limite antigos. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};
