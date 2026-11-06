import { describe, it, expect } from 'vitest';
import { call, env, seedTenant, seedUser, seedSystemAdmin, systemLogin, login, adminSession, tokenFor, todayIso } from './helpers.js';
import { addDays, addMonths, daysBetween } from '../src/lib/dates.js';
import { billingState, TRIAL_DAYS, GRACE_DAYS } from '../src/lib/billing.js';

async function system() {
  const { email, adminId } = await seedSystemAdmin();
  return { adminId, token: await systemLogin(email) };
}
const setPaidUntil = (tenantId, date, status) => env.DB.prepare('UPDATE tenants SET paid_until = ?, subscription_status = COALESCE(?, subscription_status) WHERE id = ?').bind(date, status ?? null, tenantId).run();
const get = async (s, tenantId) => (await call('GET', '/api/system/billing', { token: s.token })).json.data.items.find((t) => t.id === tenantId);
const pay = (s, tenantId, body = {}) => call('POST', `/api/system/billing/${tenantId}/payments`, { token: s.token, body: { amount_cents: 15000, ...body } });

describe('datas e situação da mensalidade (regras puras)', () => {
  it('soma meses sem estourar o fim do mês', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-03-31', 1)).toBe('2026-04-30');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonths('2026-12-31', 12)).toBe('2027-12-31');
    expect(addMonths('2026-05-31', -3)).toBe('2026-02-28');
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
    expect(daysBetween('2026-10-31', '2026-10-01')).toBe(-30);
  });

  it('classifica cada situação e diz se há acesso', () => {
    const today = '2026-10-18';
    const st = (subscription_status, paid_until) => billingState({ subscription_status, paid_until }, today);
    expect(st('ATIVA', '2026-11-30')).toMatchObject({ state: 'EM_DIA', access: true, days_left: 43 });
    expect(st('ATIVA', '2026-10-23')).toMatchObject({ state: 'VENCENDO', access: true, days_left: 5 });
    expect(st('ATIVA', '2026-10-18')).toMatchObject({ state: 'VENCENDO', access: true, days_left: 0 });
    expect(st('ATIVA', '2026-10-17')).toMatchObject({ state: 'EM_ATRASO', access: true, days_left: -1 });
    expect(st('ATIVA', addDays(today, -GRACE_DAYS))).toMatchObject({ state: 'EM_ATRASO', access: true });
    expect(st('ATIVA', addDays(today, -GRACE_DAYS - 1))).toMatchObject({ state: 'VENCIDA', access: false });
    expect(st('TESTE', '2026-10-20')).toMatchObject({ state: 'TESTE', access: true });
    expect(st('TESTE', '2026-10-01')).toMatchObject({ state: 'VENCIDA', access: false });
    expect(st('CANCELADA', '2026-10-25')).toMatchObject({ state: 'CANCELADA', access: true });
    expect(st('CANCELADA', '2026-10-17')).toMatchObject({ state: 'CANCELADA', access: false }); // sem tolerância
    expect(st('ISENTA', '2020-01-01')).toMatchObject({ state: 'ISENTA', access: true });
    expect(st('ISENTA', null)).toMatchObject({ state: 'ISENTA', access: true });
    expect(st('ATIVA', null)).toMatchObject({ state: 'VENCIDA', access: false });
  });
});

describe('só o administrador do sistema acessa o financeiro', () => {
  it('lava-jato (administrador ou operador) e visitante recebem 401', async () => {
    const f = await adminSession();
    const op = await seedUser(f.tenantId);
    const opToken = await login(op.email);
    const paths = [['GET', '/api/system/billing'], ['GET', `/api/system/billing/${f.tenantId}/payments`], ['POST', `/api/system/billing/${f.tenantId}/payments`], ['PUT', `/api/system/billing/${f.tenantId}/plan`],
      ['POST', `/api/system/billing/${f.tenantId}/cancel`], ['POST', `/api/system/billing/${f.tenantId}/reactivate`], ['POST', '/api/system/payments/1/reverse']];
    for (const [method, path] of paths) {
      for (const token of [f.token, opToken, undefined]) {
        expect((await call(method, path, { token, body: method === 'GET' ? undefined : { amount_cents: 1 } })).status, `${method} ${path}`).toBe(401);
      }
    }
  });
});

describe('painel financeiro', () => {
  it('lista os clientes (sem os pendentes), com situação, contagens e resumo', async () => {
    const s = await system();
    const ok = await seedTenant({ name: 'Em Dia Lava' });
    const late = await seedTenant({ name: 'Atrasado Lava' });
    const pending = await seedTenant({ status: 'PENDENTE', name: 'Pendente Lava' });
    await pay(s, ok.tenantId, { months: 2, amount_cents: 20000 });
    await setPaidUntil(late.tenantId, addDays(todayIso(), -10), 'ATIVA');
    await call('PUT', `/api/system/billing/${ok.tenantId}/plan`, { token: s.token, body: { plan_price_cents: 10000 } });

    const res = await call('GET', '/api/system/billing', { token: s.token });
    expect(res.status).toBe(200);
    const names = res.json.data.items.map((t) => t.business_name);
    expect(names).toContain('Em Dia Lava');
    expect(names).toContain('Atrasado Lava');
    expect(names).not.toContain('Pendente Lava');
    const first = res.json.data.items.find((t) => t.id === ok.tenantId);
    expect(first.billing).toMatchObject({ state: 'EM_DIA', access: true });
    expect(res.json.data.items.find((t) => t.id === late.tenantId).billing).toMatchObject({ state: 'VENCIDA', access: false });
    expect(res.json.data.items[0].billing.days_left).toBeLessThanOrEqual(res.json.data.items.at(-1).billing.days_left ?? 99999); // atrasados primeiro
    expect(res.json.data.summary.received_month_cents).toBeGreaterThanOrEqual(20000);
    expect(res.json.data.summary.mrr_cents).toBeGreaterThanOrEqual(10000);
    expect(res.json.data.counts.VENCIDA).toBeGreaterThanOrEqual(1);
    expect(res.json.data.counts.ATENCAO).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(res.json)).not.toContain('password_hash');
    expect(pending.tenantId).toBeTruthy();
  });

  it('filtra por situação e busca por nome; filtro inválido é recusado', async () => {
    const s = await system();
    const t = await seedTenant({ name: 'Brilho Único Xyz' });
    await setPaidUntil(t.tenantId, addDays(todayIso(), -20), 'ATIVA');
    const by = async (q) => (await call('GET', `/api/system/billing?${q}`, { token: s.token })).json.data.items.map((i) => i.id);
    expect(await by('state=VENCIDA')).toContain(t.tenantId);
    expect(await by('state=EM_DIA')).not.toContain(t.tenantId);
    expect(await by('state=ATENCAO')).toContain(t.tenantId);
    expect(await by(`q=${encodeURIComponent('brilho único')}`)).toEqual([t.tenantId]);
    expect(await by(`q=${encodeURIComponent("' OR 1=1 --")}`)).toEqual([]);
    for (const bad of ['state=QUALQUER', 'state=', `q=${'x'.repeat(100)}`]) {
      expect((await call('GET', `/api/system/billing?${bad}`, { token: s.token })).status, bad).toBe(400);
    }
  });

  it('autorizar um cliente novo começa o teste grátis, uma única vez', async () => {
    const s = await system();
    const t = await seedTenant({ status: 'PENDENTE' });
    await env.DB.prepare('UPDATE tenants SET paid_until = NULL WHERE id = ?').bind(t.tenantId).run();
    await call('POST', `/api/system/tenants/${t.tenantId}/approve`, { token: s.token, body: {} });
    const after = await get(s, t.tenantId);
    expect(after).toMatchObject({ subscription_status: 'TESTE', paid_until: addDays(todayIso(), TRIAL_DAYS) });
    expect(after.billing.state).toBe('TESTE');
    // Bloquear e desbloquear não dá outro teste
    await setPaidUntil(t.tenantId, addDays(todayIso(), 2));
    await call('POST', `/api/system/tenants/${t.tenantId}/block`, { token: s.token, body: {} });
    await call('POST', `/api/system/tenants/${t.tenantId}/unblock`, { token: s.token, body: {} });
    expect((await get(s, t.tenantId)).paid_until).toBe(addDays(todayIso(), 2));
  });
});

describe('o acesso acompanha a mensalidade', () => {
  it('vencida além da tolerância: não entra e a sessão aberta é cortada; pagar libera na hora', async () => {
    const s = await system();
    const f = await adminSession();
    await setPaidUntil(f.tenantId, addDays(todayIso(), -(GRACE_DAYS + 1)), 'ATIVA');

    expect((await call('GET', '/api/auth/me', { token: f.token })).json.error.code).toBe('SUBSCRIPTION_EXPIRED');
    expect((await call('GET', '/api/auth/me', { token: f.token })).status).toBe(403);
    const attempt = await call('POST', '/api/auth/login', { body: { id_token: await tokenFor(f.email) } });
    expect(attempt.status).toBe(403);
    expect(attempt.json.error.code).toBe('SUBSCRIPTION_EXPIRED');
    const op = await seedUser(f.tenantId);
    expect((await call('POST', '/api/auth/login', { body: { id_token: await tokenFor(op.email) } })).json.error.code).toBe('SUBSCRIPTION_EXPIRED');

    expect((await pay(s, f.tenantId)).status).toBe(201);
    expect((await call('GET', '/api/auth/me', { token: f.token })).status).toBe(200);
    await expect(login(f.email)).resolves.toBeTruthy();
  });

  it('dentro da tolerância ainda usa, e o administrador é avisado; o operador não vê a situação', async () => {
    const f = await adminSession();
    const op = await seedUser(f.tenantId);
    const opToken = await login(op.email);
    await setPaidUntil(f.tenantId, addDays(todayIso(), -GRACE_DAYS), 'ATIVA');
    const me = await call('GET', '/api/auth/me', { token: f.token });
    expect(me.status).toBe(200);
    expect(me.json.data.subscription).toMatchObject({ state: 'EM_ATRASO', days_left: -GRACE_DAYS });
    const opMe = await call('GET', '/api/auth/me', { token: opToken });
    expect(opMe.status).toBe(200);
    expect(opMe.json.data).not.toHaveProperty('subscription');
  });

  it('isento nunca vence, mesmo com data antiga', async () => {
    const s = await system();
    const f = await adminSession();
    await setPaidUntil(f.tenantId, '2021-01-01', 'ATIVA');
    expect((await call('GET', '/api/auth/me', { token: f.token })).status).toBe(403);
    await call('PUT', `/api/system/billing/${f.tenantId}/plan`, { token: s.token, body: { exempt: true } });
    const me = await call('GET', '/api/auth/me', { token: f.token });
    expect(me.status).toBe(200);
    expect(me.json.data.subscription.state).toBe('ISENTA');
  });
});

describe('registrar pagamento', () => {
  it('renova a partir do vencimento (se ainda vale) ou de hoje (se já venceu) e passa a ATIVA', async () => {
    const s = await system();
    const a = await seedTenant();
    const b = await seedTenant();
    await setPaidUntil(a.tenantId, addDays(todayIso(), 10), 'TESTE');
    await setPaidUntil(b.tenantId, addDays(todayIso(), -40), 'ATIVA');

    const ra = await pay(s, a.tenantId, { months: 1, method: 'PIX', note: 'Comprovante 123' });
    expect(ra.status).toBe(201);
    expect(ra.json.data.tenant).toMatchObject({ subscription_status: 'ATIVA', paid_until: addMonths(addDays(todayIso(), 10), 1) });
    const rb = await pay(s, b.tenantId, { months: 3 });
    expect(rb.json.data.tenant.paid_until).toBe(addMonths(todayIso(), 3));
    expect(rb.json.data.tenant.billing.access).toBe(true);

    const list = await call('GET', `/api/system/billing/${a.tenantId}/payments`, { token: s.token });
    expect(list.json.data.items).toHaveLength(1);
    expect(list.json.data.items[0]).toMatchObject({ amount_cents: 15000, months: 1, method: 'PIX', note: 'Comprovante 123', status: 'ATIVO', can_reverse: true });
  });

  it('valida valor, meses, data, forma, observação e campos extras; recusa pendente e isento', async () => {
    const s = await system();
    const t = await seedTenant();
    const bad = [{ amount_cents: 0 }, { amount_cents: -5 }, { amount_cents: 1.5 }, { amount_cents: '100' }, { amount_cents: undefined },
      { months: 0 }, { months: 13 }, { months: 1.5 }, { months: '2' }, { paid_on: addDays(todayIso(), 1) }, { paid_on: 'ontem' }, { paid_on: '1999-01-01' },
      { method: 'CHEQUE' }, { note: 'x'.repeat(201) }, { tenant_id: 9 }, { status: 'ATIVO' }, { paid_until: '2030-01-01' }];
    for (const body of bad) expect((await pay(s, t.tenantId, body)).status, JSON.stringify(body)).toBe(400);
    expect((await call('GET', `/api/system/billing/${t.tenantId}/payments`, { token: s.token })).json.data.items).toEqual([]);

    const pending = await seedTenant({ status: 'PENDENTE' });
    expect((await pay(s, pending.tenantId)).status).toBe(409);
    await call('PUT', `/api/system/billing/${t.tenantId}/plan`, { token: s.token, body: { exempt: true } });
    expect((await pay(s, t.tenantId)).status).toBe(409);
    expect((await pay(s, 99999999)).status).toBe(404);
    for (const id of ['abc', '0', '-1']) expect((await pay(s, id)).status, id).toBe(404);
  });

  it('fica na auditoria do sistema e nunca aparece para o lava-jato', async () => {
    const s = await system();
    const f = await adminSession();
    await pay(s, f.tenantId, { months: 2 });
    const platform = await call('GET', '/api/system/audit?period=today', { token: s.token });
    const item = platform.json.data.items.find((i) => i.action === 'PAYMENT_REGISTERED' && i.entity_id);
    expect(item).toBeTruthy();
    const own = await call('GET', '/api/audit?period=today', { token: f.token });
    expect(own.status).toBe(200);
    expect(own.json.data.items.map((i) => i.action)).not.toContain('PAYMENT_REGISTERED');
    expect(JSON.stringify(own.json)).not.toContain('15000');
  });
});

describe('estorno', () => {
  it('desfaz o último pagamento e devolve o vencimento e o tipo de antes', async () => {
    const s = await system();
    const t = await seedTenant();
    await setPaidUntil(t.tenantId, addDays(todayIso(), 5), 'TESTE');
    const before = await get(s, t.tenantId);
    const paid = (await pay(s, t.tenantId, { months: 2 })).json.data;

    const rev = await call('POST', `/api/system/payments/${paid.payment_id}/reverse`, { token: s.token, body: { reason: 'Pix devolvido' } });
    expect(rev.status).toBe(200);
    expect(rev.json.data.tenant).toMatchObject({ subscription_status: 'TESTE', paid_until: before.paid_until });
    const list = (await call('GET', `/api/system/billing/${t.tenantId}/payments`, { token: s.token })).json.data.items;
    expect(list[0]).toMatchObject({ status: 'ESTORNADO', reversed_reason: 'Pix devolvido', can_reverse: false });
    expect((await call('POST', `/api/system/payments/${paid.payment_id}/reverse`, { token: s.token, body: {} })).status).toBe(409);
  });

  it('só o último pagamento; e não se o vencimento foi ajustado depois', async () => {
    const s = await system();
    const t = await seedTenant();
    const first = (await pay(s, t.tenantId)).json.data;
    const second = (await pay(s, t.tenantId)).json.data;
    expect((await call('POST', `/api/system/payments/${first.payment_id}/reverse`, { token: s.token, body: {} })).status).toBe(409);
    await call('PUT', `/api/system/billing/${t.tenantId}/plan`, { token: s.token, body: { paid_until: addDays(todayIso(), 100) } });
    expect((await call('POST', `/api/system/payments/${second.payment_id}/reverse`, { token: s.token, body: {} })).status).toBe(409);
    expect((await call('POST', '/api/system/payments/99999999/reverse', { token: s.token, body: {} })).status).toBe(404);
    expect((await call('POST', `/api/system/payments/${second.payment_id}/reverse`, { token: s.token, body: { reason: 'x'.repeat(201) } })).status).toBe(400);
  });

  it('o estorno sai do total recebido no mês', async () => {
    const s = await system();
    const t = await seedTenant();
    const month = async () => (await call('GET', '/api/system/billing', { token: s.token })).json.data.summary.received_month_cents;
    const base = await month();
    const paid = (await pay(s, t.tenantId, { amount_cents: 33300 })).json.data;
    expect(await month()).toBe(base + 33300);
    await call('POST', `/api/system/payments/${paid.payment_id}/reverse`, { token: s.token, body: {} });
    expect(await month()).toBe(base);
  });
});

describe('plano, cancelamento e reativação', () => {
  it('define valor mensal, isenção e vencimento, com validação e auditoria', async () => {
    const s = await system();
    const t = await seedTenant();
    const put = (body) => call('PUT', `/api/system/billing/${t.tenantId}/plan`, { token: s.token, body });
    const res = await put({ plan_price_cents: 14990, paid_until: addDays(todayIso(), 45) });
    expect(res.json.data).toMatchObject({ plan_price_cents: 14990, paid_until: addDays(todayIso(), 45) });
    expect((await put({ exempt: true })).json.data.subscription_status).toBe('ISENTA');
    expect((await put({ exempt: false })).json.data.subscription_status).toBe('ATIVA');
    for (const body of [{}, { plan_price_cents: -1 }, { plan_price_cents: 1.5 }, { plan_price_cents: 100_000_001 }, { paid_until: 'x' }, { paid_until: '2019-12-31' }, { paid_until: '2099-01-01' }, { exempt: 'sim' }, { status: 'ATIVA' }, { subscription_status: 'ISENTA' }]) {
      expect((await put(body)).status, JSON.stringify(body)).toBe(400);
    }
    const logs = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'PLAN_CHANGED' AND tenant_id = ?").bind(t.tenantId).first();
    expect(logs.n).toBe(3);
    await put({ plan_price_cents: 14990 }); // igual ao que já está: não audita
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'PLAN_CHANGED' AND tenant_id = ?").bind(t.tenantId).first()).n).toBe(3);
  });

  it('cancelar: o acesso vale até a data paga e depois acaba; reativar com pagamento volta', async () => {
    const s = await system();
    const f = await adminSession();
    await pay(s, f.tenantId, { months: 1 });
    const res = await call('POST', `/api/system/billing/${f.tenantId}/cancel`, { token: s.token, body: { reason: 'Pediu para sair' } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ subscription_status: 'CANCELADA', subscription_cancel_reason: 'Pediu para sair' });
    expect(res.json.data.billing).toMatchObject({ state: 'CANCELADA', access: true });
    expect((await call('GET', '/api/auth/me', { token: f.token })).status).toBe(200); // ainda dentro do período pago

    await setPaidUntil(f.tenantId, addDays(todayIso(), -1));
    expect((await call('GET', '/api/auth/me', { token: f.token })).json.error.code).toBe('SUBSCRIPTION_EXPIRED'); // sem tolerância
    expect((await call('POST', `/api/system/billing/${f.tenantId}/cancel`, { token: s.token, body: {} })).status).toBe(409);

    expect((await pay(s, f.tenantId)).status).toBe(201); // novo pagamento reativa
    expect((await get(s, f.tenantId)).subscription_status).toBe('ATIVA');
    expect((await call('GET', '/api/auth/me', { token: f.token })).status).toBe(200);
  });

  it('cancelar e bloquear agora derruba as sessões; reativar mantém a data paga', async () => {
    const s = await system();
    const f = await adminSession();
    await pay(s, f.tenantId);
    const res = await call('POST', `/api/system/billing/${f.tenantId}/cancel`, { token: s.token, body: { block_now: true } });
    expect(res.status).toBe(200);
    expect((await call('GET', '/api/auth/me', { token: f.token })).status).toBe(401);
    expect((await env.DB.prepare('SELECT status FROM tenants WHERE id = ?').bind(f.tenantId).first()).status).toBe('BLOQUEADO');

    const re = await call('POST', `/api/system/billing/${f.tenantId}/reactivate`, { token: s.token, body: {} });
    expect(re.status).toBe(200);
    expect(re.json.data).toMatchObject({ subscription_status: 'ATIVA', subscription_cancel_reason: '' });
    expect((await call('POST', `/api/system/billing/${f.tenantId}/reactivate`, { token: s.token, body: {} })).status).toBe(409);
  });

  it('valida o cancelamento: isento não cancela, motivo e campos extras', async () => {
    const s = await system();
    const t = await seedTenant();
    const cancel = (body) => call('POST', `/api/system/billing/${t.tenantId}/cancel`, { token: s.token, body });
    for (const body of [{ reason: 'x'.repeat(201) }, { block_now: 'sim' }, { other: 1 }]) expect((await cancel(body)).status, JSON.stringify(body)).toBe(400);
    await call('PUT', `/api/system/billing/${t.tenantId}/plan`, { token: s.token, body: { exempt: true } });
    expect((await cancel({})).status).toBe(409);
    const pending = await seedTenant({ status: 'PENDENTE' });
    expect((await call('POST', `/api/system/billing/${pending.tenantId}/cancel`, { token: s.token, body: {} })).status).toBe(409);
  });
});
