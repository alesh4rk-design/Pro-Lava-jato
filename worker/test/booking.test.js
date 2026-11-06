import { describe, it, expect } from 'vitest';
import { call, env, financeFixture, seedService } from './helpers.js';

const WEEK_ALL = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), ['00:00', '23:00']]));
const tomorrow = () => new Date(Date.now() + 86_400_000 + 3 * 3600_000).toISOString().slice(0, 10);

async function setup(settings = {}) {
  const f = await financeFixture();
  const serviceId = await seedService(f.tenantId, { name: 'Lavagem completa', priceCents: 8000 });
  const res = await call('PUT', '/api/booking/settings', { token: f.adminToken, body: { enabled: true, hours: WEEK_ALL, slot_minutes: 60, ...settings } });
  expect(res.status).toBe(200);
  return { ...f, serviceId, code: res.json.data.code };
}

const book = (f, over = {}, ip) => call('POST', `/api/public/booking/${f.code}/appointments`, {
  ip, body: { service_id: f.serviceId, date: tomorrow(), time: '10:00', name: 'Maria Souza', phone: '(11) 97777-1234', plate: 'abc-1d23', vehicle: 'Gol', ...over },
});

describe('agendamento online: configuração', () => {
  it('só o administrador configura; link nasce desligado e com código aleatório', async () => {
    const f = await financeFixture();
    expect((await call('GET', '/api/booking/settings', { token: f.opToken })).status).toBe(403);
    const res = await call('GET', '/api/booking/settings', { token: f.adminToken });
    expect(res.json.data).toMatchObject({ enabled: false, slot_minutes: 60, capacity: 1 });
    expect(res.json.data.code).toMatch(/^[a-z0-9]{12}$/);
    const again = await call('PUT', '/api/booking/settings', { token: f.adminToken, body: { regenerate_code: true } });
    expect(again.json.data.code).not.toBe(res.json.data.code);
  });

  it('valida horários e limites', async () => {
    const f = await financeFixture();
    for (const body of [{ hours: { 9: ['08:00', '18:00'] } }, { hours: { 1: ['18:00', '08:00'] } }, { slot_minutes: 5 }, { capacity: 0 }, { max_days_ahead: 90 }, { extra: 1 }]) {
      expect((await call('PUT', '/api/booking/settings', { token: f.adminToken, body })).status).toBe(400);
    }
  });
});

describe('agendamento online: link público', () => {
  it('link desligado ou inexistente retorna 404', async () => {
    const f = await financeFixture();
    const { code } = (await call('GET', '/api/booking/settings', { token: f.adminToken })).json.data;
    expect((await call('GET', `/api/public/booking/${code}`)).status).toBe(404);
    expect((await call('GET', '/api/public/booking/xxxxxxxxxxxx')).status).toBe(404);
    expect((await call('GET', '/api/public/booking/curto')).status).toBe(404);
  });

  it('mostra só serviços ativos e não expõe ids do lava-jato', async () => {
    const f = await setup();
    await seedService(f.tenantId, { name: 'Inativo', active: 0 });
    const res = await call('GET', `/api/public/booking/${f.code}`);
    expect(res.status).toBe(200);
    const names = res.json.data.services.map((s) => s.name);
    expect(names).toContain('Lavagem completa');
    expect(names).not.toContain('Inativo');
    expect(JSON.stringify(res.json.data)).not.toContain('tenant');
  });

  it('cliente agenda, vaga some, e não passa da capacidade', async () => {
    const f = await setup();
    const slots = (await call('GET', `/api/public/booking/${f.code}/slots?date=${tomorrow()}`)).json.data.slots;
    expect(slots).toContain('10:00');
    const first = await book(f);
    expect(first.status).toBe(201);
    expect(first.json.data).toMatchObject({ status: 'PENDENTE', service: 'Lavagem completa' });
    const after = (await call('GET', `/api/public/booking/${f.code}/slots?date=${tomorrow()}`)).json.data.slots;
    expect(after).not.toContain('10:00');
    const second = await book(f, { phone: '11966665555' });
    expect(second.status).toBe(409);
  });

  it('confirma sozinho quando configurado', async () => {
    const f = await setup({ auto_confirm: true });
    expect((await book(f)).json.data.status).toBe('CONFIRMADO');
  });

  it('rejeita horário fora do expediente, passado, data distante, serviço de outro lava-jato', async () => {
    const f = await setup({ hours: { ...WEEK_ALL, [String(new Date(`${tomorrow()}T00:00:00Z`).getUTCDay())]: ['08:00', '12:00'] } });
    expect((await book(f, { time: '15:00' })).status).toBe(409);
    expect((await book(f, { date: '2020-01-01' })).status).toBe(409);
    expect((await book(f, { date: new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10) })).status).toBe(409);
    const other = await financeFixture();
    const foreign = await seedService(other.tenantId);
    expect((await book(f, { service_id: foreign })).status).toBe(400);
    expect((await book(f, { phone: '123' })).status).toBe(400);
    expect((await book(f, { name: 'x' })).status).toBe(400);
  });

  it('isca preenchida finge sucesso sem gravar', async () => {
    const f = await setup();
    expect((await book(f, { website: 'http://spam' })).status).toBe(201);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM appointments WHERE tenant_id = ?').bind(f.tenantId).first();
    expect(rows.n).toBe(0);
  });

  it('limita agendamentos em aberto por telefone', async () => {
    const f = await setup();
    for (const time of ['08:00', '09:00', '10:00']) expect((await book(f, { time })).status).toBe(201);
    expect((await book(f, { time: '11:00' })).status).toBe(409);
  });

  it('cliente consulta e cancela pelo link; horário volta a ficar livre', async () => {
    const f = await setup();
    const { token } = (await book(f)).json.data;
    expect((await call('GET', `/api/public/appointments/${token}`)).json.data).toMatchObject({ status: 'PENDENTE', time: '10:00' });
    expect((await call('POST', `/api/public/appointments/${token}/cancel`)).json.data.status).toBe('CANCELADO');
    expect((await call('POST', `/api/public/appointments/${token}/cancel`)).status).toBe(409);
    expect((await call('GET', `/api/public/appointments/${'a'.repeat(30)}`)).status).toBe(404);
    expect((await book(f, { phone: '11955554444' })).status).toBe(201);
  });

  it('lava-jato bloqueado ou com mensalidade vencida some do ar', async () => {
    const f = await setup();
    await env.DB.prepare("UPDATE tenants SET status = 'BLOQUEADO' WHERE id = ?").bind(f.tenantId).run();
    expect((await call('GET', `/api/public/booking/${f.code}`)).status).toBe(404);
  });

  it('auditoria do cliente não guarda telefone', async () => {
    const f = await setup();
    await book(f);
    const log = await env.DB.prepare("SELECT details FROM audit_logs WHERE tenant_id = ? AND action = 'APPOINTMENT_CREATED'").bind(f.tenantId).first();
    expect(log.details).not.toContain('11977771234');
  });
});

describe('agendamento online: agenda do lava-jato', () => {
  it('lista, confirma, remarca e conclui; operador também; visitante não', async () => {
    const f = await setup();
    await book(f);
    expect((await call('GET', '/api/appointments')).status).toBe(401);
    const day = (await call('GET', `/api/appointments?date=${tomorrow()}`, { token: f.opToken })).json.data.items;
    expect(day).toHaveLength(1);
    expect(day[0]).toMatchObject({ customer_name: 'Maria Souza', plate: 'ABC1D23', status: 'PENDENTE', service_name: 'Lavagem completa' });
    const summary = (await call('GET', '/api/appointments/summary', { token: f.adminToken })).json.data;
    expect(summary.pending).toBe(1);

    const id = day[0].id;
    expect((await call('PUT', `/api/appointments/${id}`, { token: f.opToken, body: { status: 'CONFIRMADO' } })).status).toBe(200);
    expect((await call('PUT', `/api/appointments/${id}`, { token: f.adminToken, body: { time: '14:00' } })).status).toBe(200);
    expect((await call('PUT', `/api/appointments/${id}`, { token: f.adminToken, body: { status: 'CONCLUIDO' } })).status).toBe(200);
    expect((await call('PUT', `/api/appointments/${id}`, { token: f.adminToken, body: { status: 'CANCELADO' } })).status).toBe(409);
    expect((await call('PUT', `/api/appointments/999999`, { token: f.adminToken, body: { status: 'CANCELADO' } })).status).toBe(404);
  });

  it('remarcar para horário cheio é recusado', async () => {
    const f = await setup();
    const a = (await book(f, { time: '10:00' })).json.data;
    await book(f, { time: '11:00' });
    const list = (await call('GET', `/api/appointments?date=${tomorrow()}`, { token: f.adminToken })).json.data.items;
    const target = list.find((i) => i.time === '11:00');
    expect((await call('PUT', `/api/appointments/${target.id}`, { token: f.adminToken, body: { time: '10:00' } })).status).toBe(409);
    expect(a.time).toBe('10:00');
  });

  it('isolamento entre lava-jatos', async () => {
    const f = await setup();
    await book(f);
    const other = await financeFixture();
    const id = (await call('GET', `/api/appointments?date=${tomorrow()}`, { token: f.adminToken })).json.data.items[0].id;
    expect((await call('GET', `/api/appointments?date=${tomorrow()}`, { token: other.adminToken })).json.data.items).toEqual([]);
    expect((await call('PUT', `/api/appointments/${id}`, { token: other.adminToken, body: { status: 'CANCELADO' } })).status).toBe(404);
  });

  it('cadastro manual entra confirmado', async () => {
    const f = await setup();
    const res = await call('POST', '/api/appointments', { token: f.opToken, body: { service_id: f.serviceId, date: tomorrow(), time: '09:30', name: 'Pedro Lima', phone: '11 98888-0000' } });
    expect(res.status).toBe(201);
    const items = (await call('GET', `/api/appointments?date=${tomorrow()}`, { token: f.adminToken })).json.data.items;
    expect(items[0]).toMatchObject({ status: 'CONFIRMADO', source: 'MANUAL' });
  });
});
