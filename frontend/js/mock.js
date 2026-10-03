// MODO DEMONSTRAÇÃO (Etapa 1): simula a API do Worker com o mesmo contrato JSON.
// Carregado apenas quando config.USE_MOCK = true. Não contém credenciais: aceita qualquer
// e-mail válido com senha de 8+ caracteres. Prefixos de e-mail simulam situações:
//   operador@...  -> perfil OPERADOR      pendente@... -> acesso aguardando autorização
//   bloqueado@... -> acesso bloqueado     erro@...     -> falha interna do servidor

import { config } from './config.js';
import { isValidEmail, isValidISODate, todayISO } from './format.js';

const DAY_MS = 86_400_000;
const FIXED_EXPENSES_MONTH_CENTS = 315_000;

const tenants = [
  { id: 1, business_name: 'Lava-Jato Demonstração', owner_name: 'Responsável Demo', email: 'demo@exemplo.com', phone: '(11) 90000-0001', status: 'ATIVO', created_at: '2026-08-12' },
  { id: 2, business_name: 'Brilho Car Wash', owner_name: 'Carlos Souza', email: 'carlos@exemplo.com', phone: '(11) 90000-0002', status: 'PENDENTE', created_at: '2026-10-01' },
  { id: 3, business_name: 'Auto Spa Centro', owner_name: 'Fernanda Lima', email: 'fernanda@exemplo.com', phone: '', status: 'PENDENTE', created_at: '2026-10-02' },
  { id: 4, business_name: 'Lavagem Express', owner_name: 'Rafael Dias', email: 'rafael@exemplo.com', phone: '(21) 90000-0004', status: 'BLOQUEADO', created_at: '2026-06-20' },
];

const ok = (data, status = 200) => ({ status, payload: { success: true, data } });
const fail = (status, code, message) => ({ status, payload: { success: false, error: { code, message } } });
const delay = () => new Promise((r) => setTimeout(r, 350));

export async function handleMock(method, fullPath, body, session) {
  await delay();
  const [path, query = ''] = fullPath.split('?');
  const params = new URLSearchParams(query);

  if (method === 'POST' && (path === '/auth/login' || path === '/system/auth/login')) {
    return mockLogin(body, path.startsWith('/system'));
  }
  if (method === 'POST' && path === '/access-requests') return mockAccessRequest(body);
  if (!session) return fail(401, 'UNAUTHENTICATED', 'Sessão expirada. Entre novamente.');
  if (method === 'POST' && path.endsWith('/auth/logout')) return ok({});

  const isSystem = session.user.role === 'SUPER_ADMIN';
  if (method === 'GET' && path === '/dashboard' && !isSystem) return mockDashboard(params);
  if (path.startsWith('/system/')) {
    if (!isSystem) return fail(403, 'FORBIDDEN', 'Você não tem permissão para esta ação.');
    return mockSystem(method, path, params);
  }
  return fail(404, 'NOT_FOUND', 'Recurso não encontrado.');
}

function mockLogin(body, system) {
  const email = String(body?.email ?? '');
  if (!isValidEmail(email) || String(body?.password ?? '').length < 8) {
    return fail(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
  }
  const prefix = email.split('@')[0];
  if (prefix === 'erro') return fail(500, 'INTERNAL_ERROR', 'Não foi possível concluir a operação. Tente novamente.');
  if (prefix === 'pendente') return fail(403, 'ACCESS_PENDING', 'Seu acesso ainda não foi autorizado pelo administrador do sistema.');
  if (prefix === 'bloqueado') return fail(403, 'ACCESS_BLOCKED', 'Acesso bloqueado. Entre em contato com o administrador do sistema.');

  const token = `demo-${crypto.randomUUID()}`;
  if (system) {
    return ok({ token, user: { id: 1, name: 'Administrador do Sistema', role: 'SUPER_ADMIN' } });
  }
  return ok({
    token,
    user: { id: 1, name: prefix === 'operador' ? 'Operador Demo' : 'Responsável Demo', role: prefix === 'operador' ? 'OPERADOR' : 'ADMIN' },
    tenant: { id: 1, name: 'Lava-Jato Demonstração' },
  });
}

function mockAccessRequest(body) {
  const required = ['business_name', 'owner_name', 'email', 'password'];
  if (required.some((k) => !String(body?.[k] ?? '').trim()) || !isValidEmail(body.email)) {
    return fail(400, 'VALIDATION_ERROR', 'Dados inválidos.');
  }
  tenants.push({
    id: tenants.length + 1,
    business_name: body.business_name,
    owner_name: body.owner_name,
    email: body.email,
    phone: body.phone ?? '',
    status: 'PENDENTE',
    created_at: todayISO(config.TIMEZONE),
  });
  return ok({ status: 'PENDENTE' }, 201);
}

function mockSystem(method, path, params) {
  if (method === 'GET' && path === '/system/tenants') {
    const status = params.get('status');
    const counts = { PENDENTE: 0, ATIVO: 0, BLOQUEADO: 0 };
    tenants.forEach((t) => { counts[t.status] += 1; });
    const items = tenants.filter((t) => !status || t.status === status).slice().reverse();
    return ok({ items, counts });
  }

  const match = path.match(/^\/system\/tenants\/(\d+)\/(approve|block|unblock)$/);
  if (method === 'POST' && match) {
    const tenant = tenants.find((t) => t.id === Number(match[1]));
    if (!tenant) return fail(404, 'NOT_FOUND', 'Cliente não encontrado.');
    const allowed = { approve: ['PENDENTE'], block: ['PENDENTE', 'ATIVO'], unblock: ['BLOQUEADO'] };
    if (!allowed[match[2]].includes(tenant.status)) return fail(409, 'INVALID_STATE', 'Ação não permitida para a situação atual.');
    tenant.status = match[2] === 'block' ? 'BLOQUEADO' : 'ATIVO';
    return ok(tenant);
  }
  return fail(404, 'NOT_FOUND', 'Recurso não encontrado.');
}

/* Dashboard: números determinísticos por dia, para a tela ter dados coerentes. */

const toDate = (iso) => new Date(`${iso}T00:00:00Z`);
const toISO = (date) => date.toISOString().slice(0, 10);
const addDays = (iso, n) => toISO(new Date(toDate(iso).getTime() + n * DAY_MS));
const monthStart = (iso) => `${iso.slice(0, 8)}01`;

function dayFigures(iso) {
  const date = toDate(iso);
  const seed = Math.sin(date.getTime() / DAY_MS) * 10_000;
  const factor = 0.6 + (seed - Math.floor(seed)) * 0.8;
  const weekdayFactor = date.getUTCDay() === 0 ? 0.4 : date.getUTCDay() === 6 ? 1.4 : 1;
  const services = Math.round(10 * factor * weekdayFactor);
  const revenue = services * 5_900;
  return { services, revenue, variableCosts: Math.round(revenue * 0.39) };
}

function sumRange(start, end, today) {
  const total = { services: 0, revenue: 0, variableCosts: 0, fixed: 0 };
  const last = end < today ? end : today;
  for (let d = start; d <= last; d = addDays(d, 1)) {
    const f = dayFigures(d);
    total.services += f.services;
    total.revenue += f.revenue;
    total.variableCosts += f.variableCosts;
    total.fixed += Math.round(FIXED_EXPENSES_MONTH_CENTS / 30);
  }
  total.result = total.revenue - total.variableCosts - total.fixed;
  return total;
}

function resolvePeriod(params, today) {
  const key = params.get('period') ?? 'month';
  switch (key) {
    case 'today': return { key, start: today, end: today };
    case '7d': return { key, start: addDays(today, -6), end: today };
    case 'last_month': {
      const end = addDays(monthStart(today), -1);
      return { key, start: monthStart(end), end };
    }
    case 'year': return { key, start: `${today.slice(0, 4)}-01-01`, end: today };
    case 'custom': {
      const start = params.get('start');
      const end = params.get('end');
      if (!isValidISODate(start) || !isValidISODate(end) || start > end) return null;
      return { key, start, end };
    }
    default: return { key: 'month', start: monthStart(today), end: today };
  }
}

function mockDashboard(params) {
  const today = todayISO(config.TIMEZONE);
  const period = resolvePeriod(params, today);
  if (!period) return fail(400, 'VALIDATION_ERROR', 'Período inválido.');

  const t = sumRange(period.start, period.end, today);
  const weekday = (toDate(today).getUTCDay() + 6) % 7;
  const month = sumRange(monthStart(today), today, today);

  return ok({
    period,
    totals: {
      revenue_cents: t.revenue,
      variable_costs_cents: t.variableCosts,
      expenses_cents: t.fixed,
      result_cents: t.result,
      margin_bp: t.revenue > 0 ? Math.round((t.result * 10_000) / t.revenue) : null,
      services_count: t.services,
      avg_ticket_cents: t.services > 0 ? Math.round(t.revenue / t.services) : 0,
    },
    snapshot: {
      revenue_today_cents: dayFigures(today).revenue,
      revenue_week_cents: sumRange(addDays(today, -weekday), today, today).revenue,
      revenue_month_cents: month.revenue,
      costs_month_cents: month.variableCosts,
      expenses_month_cents: month.fixed,
      result_month_cents: month.result,
    },
  });
}
