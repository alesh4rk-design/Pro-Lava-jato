import { describe, it, expect } from 'vitest';
import { call, env, financeFixture, adminSession, seedCategory, seedTenant, todayIso, login } from './helpers.js';
import { isDueOn, dueDates, nextDate, generateDue } from '../src/recurring.js';
import { addDays } from '../src/lib/dates.js';

const base = (f, overrides = {}) => ({
  category_id: f.categoryId, description: 'Aluguel do galpão', amount_cents: 250000, payment_method: 'PIX', frequency: 'MENSAL', month_day: 5, ...overrides,
});

/** Insere direto no banco (a API não aceita início no passado) para testar recuperação de dias. */
async function insertRec(f, o = {}) {
  const row = await env.DB.prepare(
    `INSERT INTO recurring_expenses (tenant_id, category_id, description, amount_cents, payment_method, type, frequency, weekday, month_day, start_date, end_date, last_generated_date, active, created_by)
     VALUES (?, ?, ?, ?, 'PIX', 'DESPESA_FIXA', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(f.tenantId, f.categoryId, o.description ?? 'Teste', o.amount_cents ?? 1000, o.frequency ?? 'DIARIA', o.weekday ?? null, o.month_day ?? null,
    o.start_date ?? addDays(todayIso(), -3), o.end_date ?? null, o.last_generated_date ?? null, o.active ?? 1, f.userId).first();
  return row.id;
}
const generated = async (id) => (await env.DB.prepare('SELECT date, status FROM expenses WHERE recurring_expense_id = ? ORDER BY date').bind(id).all()).results;

describe('agenda (funções puras)', () => {
  const rec = (o) => ({ start_date: '2026-01-01', end_date: null, last_generated_date: null, ...o });
  it('mensal: dia 31 vale como último dia do mês; fevereiro e meses de 30 dias', () => {
    const r = rec({ frequency: 'MENSAL', month_day: 31 });
    expect(isDueOn(r, '2026-02-28')).toBe(true);
    expect(isDueOn(r, '2026-02-27')).toBe(false);
    expect(isDueOn(r, '2026-04-30')).toBe(true);
    expect(isDueOn(r, '2028-02-29')).toBe(true); // ano bissexto
    expect(isDueOn(rec({ frequency: 'MENSAL', month_day: 5 }), '2026-03-05')).toBe(true);
  });
  it('semanal: só no dia da semana escolhido (0 = domingo)', () => {
    const monday = rec({ frequency: 'SEMANAL', weekday: 1 });
    expect(isDueOn(monday, '2026-10-19')).toBe(true); // segunda
    expect(isDueOn(monday, '2026-10-20')).toBe(false);
  });
  it('respeita início e fim', () => {
    const r = rec({ frequency: 'DIARIA', start_date: '2026-03-10', end_date: '2026-03-12' });
    expect(['2026-03-09', '2026-03-10', '2026-03-12', '2026-03-13'].map((d) => isDueOn(r, d))).toEqual([false, true, true, false]);
  });
  it('dueDates recupera só o que falta, nunca depois de hoje nem do fim', () => {
    const r = rec({ frequency: 'DIARIA', start_date: '2026-03-01', last_generated_date: '2026-03-03' });
    expect(dueDates(r, '2026-03-06')).toEqual(['2026-03-04', '2026-03-05', '2026-03-06']);
    expect(dueDates({ ...r, end_date: '2026-03-04' }, '2026-03-06')).toEqual(['2026-03-04']);
    expect(dueDates({ ...r, last_generated_date: '2026-03-06' }, '2026-03-06')).toEqual([]);
  });
  it('recuperação limitada a dois meses', () => {
    const r = rec({ frequency: 'DIARIA', start_date: '2020-01-01' });
    expect(dueDates(r, '2026-03-06').length).toBeLessThanOrEqual(63);
  });
  it('nextDate: pausada não tem próxima; ativa aponta o próximo vencimento depois de hoje', () => {
    const r = rec({ frequency: 'SEMANAL', weekday: 1, active: true, last_generated_date: '2026-10-19' });
    expect(nextDate(r, '2026-10-19')).toBe('2026-10-26');
    expect(nextDate({ ...r, active: false }, '2026-10-19')).toBeNull();
    expect(nextDate({ ...r, end_date: '2026-10-20' }, '2026-10-19')).toBeNull();
  });
});

describe('permissões e isolamento', () => {
  it('operador e visitante não acessam; cada lava-jato só enxerga as próprias', async () => {
    const a = await financeFixture();
    for (const [method, path] of [['GET', '/api/recurring-expenses'], ['POST', '/api/recurring-expenses'], ['GET', '/api/recurring-expenses/upcoming'], ['PUT', '/api/recurring-expenses/1']]) {
      expect((await call(method, path, { token: a.opToken, body: method === 'GET' ? undefined : base(a) })).status, `${method} ${path}`).toBe(403);
      expect((await call(method, path, { body: method === 'GET' ? undefined : base(a) })).status).toBe(401);
    }
    const created = await call('POST', '/api/recurring-expenses', { token: a.adminToken, body: base(a) });
    expect(created.status).toBe(201);

    const b = await adminSession();
    expect((await call('GET', '/api/recurring-expenses', { token: b.token })).json.data.items).toEqual([]);
    expect((await call('PUT', `/api/recurring-expenses/${created.json.data.id}`, { token: b.token, body: { amount_cents: 1 } })).status).toBe(404);
    const bCategory = await seedCategory(b.tenantId);
    expect((await call('POST', '/api/recurring-expenses', { token: a.adminToken, body: base(a, { category_id: bCategory }) })).status).toBe(400);
  });
});

describe('cadastro', () => {
  it('mensal começando hoje lança hoje mesmo, com auditoria, e informa a próxima data', async () => {
    const f = await financeFixture();
    const today = todayIso();
    const res = await call('POST', '/api/recurring-expenses', { token: f.adminToken, body: base(f, { frequency: 'DIARIA', month_day: undefined }) });
    expect(res.status).toBe(201);
    expect(res.json.data).toMatchObject({ frequency: 'DIARIA', active: true, last_generated_date: today, next_date: addDays(today, 1), category_name: expect.any(String) });
    expect(await generated(res.json.data.id)).toEqual([{ date: today, status: 'ATIVO' }]);

    const list = await call('GET', `/api/expenses?period=today`, { token: f.adminToken });
    expect(list.json.data.items.some((i) => i.description === 'Aluguel do galpão' && i.amount_cents === 250000)).toBe(true);
    const log = await env.DB.prepare("SELECT action FROM audit_logs WHERE tenant_id = ? AND entity = 'recurring_expense' ORDER BY id").bind(f.tenantId).all();
    expect(log.results.map((r) => r.action)).toEqual(['RECURRING_CREATED', 'EXPENSE_AUTO_CREATED']);
  });

  it('começando no futuro não lança nada ainda e mostra o primeiro vencimento', async () => {
    const f = await financeFixture();
    const start = addDays(todayIso(), 10);
    const res = await call('POST', '/api/recurring-expenses', { token: f.adminToken, body: base(f, { frequency: 'DIARIA', month_day: undefined, start_date: start }) });
    expect(res.json.data.next_date).toBe(start);
    expect(await generated(res.json.data.id)).toEqual([]);
  });

  it('valida frequência, dia, datas, valor, categoria e campos extras', async () => {
    const f = await financeFixture();
    const post = (body) => call('POST', '/api/recurring-expenses', { token: f.adminToken, body });
    const revenueCategory = await seedCategory(f.tenantId, { kind: 'PRODUTO' }); // categoria que não é de despesa
    const t = todayIso();
    const bad = [
      base(f, { frequency: 'ANUAL' }), base(f, { frequency: 'SEMANAL', month_day: undefined }), base(f, { frequency: 'SEMANAL', weekday: 7, month_day: undefined }),
      base(f, { month_day: 0 }), base(f, { month_day: 32 }), base(f, { month_day: '5' }),
      base(f, { start_date: addDays(t, -1) }), base(f, { start_date: addDays(t, 400) }), base(f, { start_date: 'ontem' }),
      base(f, { end_date: addDays(t, -5) }), base(f, { amount_cents: 0 }), base(f, { amount_cents: -50 }), base(f, { amount_cents: 1.5 }),
      base(f, { payment_method: 'CHEQUE' }), base(f, { type: 'X' }), base(f, { category_id: revenueCategory }), base(f, { category_id: 999999 }),
      base(f, { description: 'x'.repeat(121) }), { ...base(f), tenant_id: 2 }, { ...base(f), status: 'ATIVO' }, { ...base(f), last_generated_date: '2000-01-01' },
    ];
    for (const body of bad) expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    expect((await post(base(f))).status).toBe(201);
  });
});

describe('lançamento automático', () => {
  it('recupera os dias que faltam e nunca lança a mesma data duas vezes', async () => {
    const f = await financeFixture();
    const id = await insertRec(f, { frequency: 'DIARIA', start_date: addDays(todayIso(), -3) });
    expect(await generateDue(env, { tenantId: f.tenantId })).toBe(4); // 3 dias atrás até hoje
    expect((await generated(id)).map((r) => r.date)).toEqual([-3, -2, -1, 0].map((n) => addDays(todayIso(), n)));
    expect(await generateDue(env, { tenantId: f.tenantId })).toBe(0);
    expect(await generated(id)).toHaveLength(4);
  });

  it('execuções simultâneas não duplicam', async () => {
    const f = await financeFixture();
    const id = await insertRec(f, { frequency: 'DIARIA', start_date: addDays(todayIso(), -5) });
    await Promise.all([generateDue(env), generateDue(env), generateDue(env, { tenantId: f.tenantId })]);
    expect(await generated(id)).toHaveLength(6);
  });

  it('semanal e mensal só lançam nos dias certos', async () => {
    const f = await financeFixture();
    const t = todayIso();
    const weekday = new Date(`${addDays(t, -2)}T00:00:00Z`).getUTCDay();
    const weekly = await insertRec(f, { frequency: 'SEMANAL', weekday, start_date: addDays(t, -6) });
    const monthly = await insertRec(f, { frequency: 'MENSAL', month_day: Number(addDays(t, -1).slice(8)), start_date: addDays(t, -3) });
    await generateDue(env, { tenantId: f.tenantId });
    expect((await generated(weekly)).map((r) => r.date)).toEqual([addDays(t, -2)]);
    expect((await generated(monthly)).map((r) => r.date)).toEqual([addDays(t, -1)]);
  });

  it('respeita data final, pausa e lava-jato não ativo', async () => {
    const f = await financeFixture();
    const t = todayIso();
    const ended = await insertRec(f, { frequency: 'DIARIA', start_date: addDays(t, -4), end_date: addDays(t, -2) });
    const paused = await insertRec(f, { frequency: 'DIARIA', active: 0 });
    await generateDue(env, { tenantId: f.tenantId });
    expect((await generated(ended)).map((r) => r.date)).toEqual([addDays(t, -4), addDays(t, -3), addDays(t, -2)]);
    expect(await generated(paused)).toEqual([]);

    const blocked = await seedTenant({ status: 'BLOQUEADO' });
    const cat = await seedCategory(blocked.tenantId);
    const blockedRec = await insertRec({ tenantId: blocked.tenantId, categoryId: cat, userId: blocked.userId }, { frequency: 'DIARIA' });
    await generateDue(env);
    expect(await generated(blockedRec)).toEqual([]);
  });

  it('lançamento cancelado ou editado não volta, e editar a recorrência não muda o que já foi lançado', async () => {
    const f = await financeFixture();
    const created = await call('POST', '/api/recurring-expenses', { token: f.adminToken, body: base(f, { frequency: 'DIARIA', month_day: undefined }) });
    const id = created.json.data.id;
    const [entry] = (await env.DB.prepare('SELECT id FROM expenses WHERE recurring_expense_id = ?').bind(id).all()).results;
    expect((await call('DELETE', `/api/expenses/${entry.id}`, { token: f.adminToken, body: { reason: 'teste' } })).status).toBe(200);
    expect((await call('PUT', `/api/recurring-expenses/${id}`, { token: f.adminToken, body: { amount_cents: 999 } })).status).toBe(200);
    expect(await generated(id)).toEqual([{ date: todayIso(), status: 'CANCELADO' }]);
    const stored = await env.DB.prepare('SELECT amount_cents FROM expenses WHERE id = ?').bind(entry.id).first();
    expect(stored.amount_cents).toBe(250000);
  });

  it('o Cron diário (todos os lava-jatos) lança para quem tem vencimento', async () => {
    const a = await financeFixture();
    const b = await financeFixture();
    const ida = await insertRec(a, { frequency: 'DIARIA', start_date: todayIso() });
    const idb = await insertRec(b, { frequency: 'DIARIA', start_date: todayIso() });
    expect(await generateDue(env)).toBeGreaterThanOrEqual(2);
    expect(await generated(ida)).toHaveLength(1);
    expect(await generated(idb)).toHaveLength(1);
  });
});

describe('editar, pausar e retomar', () => {
  it('pausar, retomar sem lançar os dias parados, mudar valor e agenda', async () => {
    const f = await financeFixture();
    const t = todayIso();
    const id = await insertRec(f, { frequency: 'DIARIA', start_date: addDays(t, -10), last_generated_date: addDays(t, -10), active: 0 });

    const resumed = await call('PUT', `/api/recurring-expenses/${id}`, { token: f.adminToken, body: { active: true } });
    expect(resumed.status).toBe(200);
    expect((await generated(id)).map((r) => r.date)).toEqual([t]); // só hoje: os 9 dias parados não voltam

    const paused = await call('PUT', `/api/recurring-expenses/${id}`, { token: f.adminToken, body: { active: false } });
    expect(paused.json.data).toMatchObject({ active: false, next_date: null });

    const changed = await call('PUT', `/api/recurring-expenses/${id}`, { token: f.adminToken, body: { frequency: 'SEMANAL', weekday: 3, amount_cents: 5000, description: 'Diarista' } });
    expect(changed.json.data).toMatchObject({ frequency: 'SEMANAL', weekday: 3, month_day: null, amount_cents: 5000, description: 'Diarista' });
    const logs = await env.DB.prepare("SELECT action FROM audit_logs WHERE entity = 'recurring_expense' AND entity_id = ? AND action = 'RECURRING_UPDATED'").bind(id).all();
    expect(logs.results).toHaveLength(3);
  });

  it('valida a edição', async () => {
    const f = await financeFixture();
    const id = (await call('POST', '/api/recurring-expenses', { token: f.adminToken, body: base(f) })).json.data.id;
    const put = (body) => call('PUT', `/api/recurring-expenses/${id}`, { token: f.adminToken, body });
    for (const body of [{}, { amount_cents: 0 }, { frequency: 'SEMANAL' }, { month_day: 40 }, { active: 'sim' }, { start_date: '2030-01-01' }, { end_date: '2000-01-01' }, { tenant_id: 9 }]) {
      expect((await put(body)).status, JSON.stringify(body)).toBe(400);
    }
    for (const badId of ['abc', '0', '-1', '99999999']) expect((await call('PUT', `/api/recurring-expenses/${badId}`, { token: f.adminToken, body: { amount_cents: 5 } })).status).toBe(404);
    expect((await put({ end_date: null })).status).toBe(200);
  });
});

describe('próximos vencimentos (alertas)', () => {
  it('lista o que vence nos próximos dias, em ordem, com dias restantes e total', async () => {
    const f = await financeFixture();
    const t = todayIso();
    const in2 = addDays(t, 2);
    const monthly = await call('POST', '/api/recurring-expenses', { token: f.adminToken, body: base(f, { month_day: Number(in2.slice(8)), start_date: t, amount_cents: 100000, description: 'Internet' }) });
    const weeklyDay = new Date(`${addDays(t, 6)}T00:00:00Z`).getUTCDay();
    await call('POST', '/api/recurring-expenses', { token: f.adminToken, body: base(f, { frequency: 'SEMANAL', weekday: weeklyDay, month_day: undefined, amount_cents: 30000, description: 'Diarista' }) });
    await call('POST', '/api/recurring-expenses', { token: f.adminToken, body: base(f, { month_day: Number(addDays(t, 20).slice(8)), amount_cents: 7000, description: 'Longe' }) });
    expect(monthly.status).toBe(201);

    await call('POST', '/api/recurring-expenses', { token: f.adminToken, body: base(f, { frequency: 'DIARIA', month_day: undefined, description: 'Todo dia' }) });
    const res = await call('GET', '/api/recurring-expenses/upcoming', { token: f.adminToken });
    expect(res.status).toBe(200); // a diária não entra no aviso
    expect(res.json.data.items.map((i) => [i.description, i.days_left])).toEqual([['Internet', 2], ['Diarista', 6]]);
    expect(res.json.data.total_cents).toBe(130000);

    const wide = await call('GET', '/api/recurring-expenses/upcoming?days=31', { token: f.adminToken });
    expect(wide.json.data.items.map((i) => i.description)).toContain('Longe');
    for (const bad of ['0', 'abc', '-3', '999']) expect((await call('GET', `/api/recurring-expenses/upcoming?days=${bad}`, { token: f.adminToken })).status).toBe(200);
  });

  it('pausadas não geram alerta', async () => {
    const f = await financeFixture();
    const t = todayIso();
    const id = (await call('POST', '/api/recurring-expenses', { token: f.adminToken, body: base(f, { month_day: Number(addDays(t, 1).slice(8)) }) })).json.data.id;
    await call('PUT', `/api/recurring-expenses/${id}`, { token: f.adminToken, body: { active: false } });
    expect((await call('GET', '/api/recurring-expenses/upcoming', { token: f.adminToken })).json.data.items).toEqual([]);
  });
});
