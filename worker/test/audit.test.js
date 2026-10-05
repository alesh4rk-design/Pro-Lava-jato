import { describe, it, expect } from 'vitest';
import { call, financeFixture, seedTenant, seedSystemAdmin, systemLogin, login, env, todayIso } from './helpers.js';
import { localDaysToUtcRange } from '../src/lib/dates.js';
import { cleanup } from '../src/maintenance.js';
import { sha256Hex } from '../src/lib/crypto.js';

const post = (f, path, body, token = f.adminToken) => call('POST', path, { token, body: { date: todayIso(), payment_method: 'PIX', ...body } });

describe('auditoria do lava-jato', () => {
  it('admin vê quem fez o quê, com nomes e detalhes, sem hash de IP', async () => {
    const f = await financeFixture();
    const { json } = await post(f, '/api/revenues', { service_id: f.serviceId, amount_cents: 7000 }, f.opToken);
    await call('DELETE', `/api/revenues/${json.data.id}`, { token: f.adminToken, body: { reason: 'Lançado em dobro' } });

    const res = await call('GET', '/api/audit?period=today', { token: f.adminToken });
    expect(res.status).toBe(200);
    const actions = res.json.data.items.map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['REVENUE_CANCELLED', 'REVENUE_CREATED', 'LOGIN']));
    const cancelled = res.json.data.items.find((i) => i.action === 'REVENUE_CANCELLED');
    expect(cancelled).toMatchObject({ entity: 'revenue', entity_id: json.data.id, actor_name: 'Usuário Teste', details: { reason: 'Lançado em dobro', amount_cents: 7000 } });
    const created = res.json.data.items.find((i) => i.action === 'REVENUE_CREATED');
    expect(created.actor_name).toBe('Outro Usuário');
    expect(JSON.stringify(res.json)).not.toContain('ip_hash');
  });

  it('filtra por grupo de ações e por usuário', async () => {
    const f = await financeFixture();
    await post(f, '/api/expenses', { category_id: f.categoryId, amount_cents: 100 }, f.opToken);
    const launches = await call('GET', '/api/audit?period=today&group=LANCAMENTOS', { token: f.adminToken });
    expect(launches.json.data.items.map((i) => i.action)).toEqual(['EXPENSE_CREATED']);
    const byOperator = await call('GET', `/api/audit?period=today&user_id=${f.opUserId}`, { token: f.adminToken });
    expect(byOperator.json.data.items.every((i) => i.actor_name === 'Outro Usuário')).toBe(true);
    expect((await call('GET', '/api/audit?group=TUDO', { token: f.adminToken })).status).toBe(400);
  });

  it('operador não acessa; lava-jatos não veem a auditoria uns dos outros', async () => {
    const a = await financeFixture();
    const b = await financeFixture();
    await post(b, '/api/revenues', { service_id: b.serviceId, amount_cents: 1234 });
    expect((await call('GET', '/api/audit', { token: a.opToken })).status).toBe(403);
    const res = await call('GET', '/api/audit?period=today', { token: a.adminToken });
    expect(res.json.data.items.some((i) => i.details.amount_cents === 1234)).toBe(false);
  });

  it('período usa o dia de Brasília (UTC−3)', () => {
    expect(localDaysToUtcRange('2026-10-05', '2026-10-05', 'America/Sao_Paulo'))
      .toEqual({ from: '2026-10-05T03:00:00.000Z', to: '2026-10-06T03:00:00.000Z' });
  });
});

describe('auditoria da plataforma', () => {
  it('administrador do sistema vê autorizações e solicitações; lava-jato não acessa', async () => {
    const { email } = await seedSystemAdmin();
    const sysToken = await systemLogin(email);
    const pending = await seedTenant({ status: 'PENDENTE', name: 'Auto Spa Teste' });
    await call('POST', `/api/system/tenants/${pending.tenantId}/approve`, { token: sysToken, body: {} });

    const res = await call('GET', '/api/system/audit?period=today', { token: sysToken });
    expect(res.status).toBe(200);
    const approved = res.json.data.items.find((i) => i.action === 'TENANT_APPROVED' && i.entity_id === pending.tenantId);
    expect(approved).toMatchObject({ actor_type: 'SYSTEM_ADMIN', actor_name: 'Admin Sistema', business_name: 'Auto Spa Teste' });

    const tenantToken = await login(pending.email);
    expect((await call('GET', '/api/system/audit', { token: tenantToken })).status).toBe(401);
  });
});

describe('sessão e limites', () => {
  it('sessão com mais de 30 dias expira mesmo em uso contínuo', async () => {
    const f = await financeFixture();
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    await env.DB.prepare('UPDATE sessions SET created_at = ? WHERE token_hash = ?').bind(old, await sha256Hex(f.adminToken)).run();
    expect((await call('GET', '/api/auth/me', { token: f.adminToken })).status).toBe(401);
  });

  it('limita gravações por usuário (120 por minuto)', async () => {
    const f = await financeFixture();
    await env.DB.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 120, ?)')
      .bind(`write:tenant:${f.opUserId}`, Math.floor(Date.now() / 1000)).run();
    const res = await post(f, '/api/expenses', { category_id: f.categoryId, amount_cents: 100 }, f.opToken);
    expect(res.status).toBe(429);
    // leitura continua liberada; outro usuário não é afetado
    expect((await call('GET', '/api/cash', { token: f.opToken })).status).toBe(200);
    expect((await post(f, '/api/expenses', { category_id: f.categoryId, amount_cents: 100 })).status).toBe(201);
  });

  it('limpeza diária remove sessões vencidas e contadores antigos, sem tocar na auditoria', async () => {
    const f = await financeFixture();
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, last_seen_at) VALUES ('velha', ?, ?, ?, ?)").bind(f.userId, f.tenantId, old, old),
      env.DB.prepare("INSERT INTO rate_limits (key, count, window_start) VALUES ('antigo', 1, ?)").bind(Math.floor(Date.now() / 1000) - 3 * 86_400),
    ]);
    const auditBefore = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_logs').first();

    const result = await cleanup(env);
    expect(result.sessions).toBeGreaterThanOrEqual(1);
    expect(result.rate_limits).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare("SELECT 1 FROM sessions WHERE token_hash = 'velha'").first()).toBeNull();
    expect((await call('GET', '/api/auth/me', { token: f.adminToken })).status).toBe(200); // sessão válida mantida
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_logs').first()).n).toBe(auditBefore.n);
  });
});

describe('desempenho: consultas principais usam índices', () => {
  const plan = async (sql, ...binds) => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all();
    return results.map((r) => r.detail).join(' | ');
  };
  const cases = [
    ['dashboard (receitas do período)', "SELECT SUM(amount_cents) FROM revenues WHERE tenant_id = 1 AND status = 'ATIVO' AND date BETWEEN '2026-10-01' AND '2026-10-31'", 'revenues'],
    ['despesas do período', "SELECT type, SUM(amount_cents) FROM expenses WHERE tenant_id = 1 AND status = 'ATIVO' AND date BETWEEN '2026-10-01' AND '2026-10-31' GROUP BY type", 'expenses'],
    ['sessão pelo token', "SELECT id FROM sessions WHERE token_hash = 'x'", 'sessions'],
    ['auditoria do período', "SELECT id FROM audit_logs WHERE tenant_id = 1 AND created_at >= '2026-10-01' ORDER BY id DESC LIMIT 50", 'audit_logs'],
    ['movimentações do produto', 'SELECT id FROM product_movements WHERE tenant_id = 1 AND product_id = 2 ORDER BY id DESC LIMIT 30', 'product_movements'],
    ['usuário pelo e-mail', "SELECT id FROM users WHERE email = 'a@b.com'", 'users'],
  ];
  for (const [name, sql, table] of cases) {
    it(name, async () => {
      const detail = await plan(sql);
      expect(detail, detail).toMatch(/USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY/);
      expect(detail, detail).not.toMatch(new RegExp(`SCAN ${table}(?! USING)`));
    });
  }
});
