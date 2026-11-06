import { describe, it, expect } from 'vitest';
import { call, env, adminSession, seedUser, seedService } from './helpers.js';

describe('primeiros passos', () => {
  it('começa tudo pendente e marca conforme os dados aparecem; só o administrador vê', async () => {
    const a = await adminSession();
    const start = await call('GET', '/api/onboarding', { token: a.token });
    expect(start.status).toBe(200);
    expect(start.json.data).toEqual({ services: false, pix: false, customers: false, recurring: false, operator: false, booking: false, revenue: false });

    await seedService(a.tenantId);
    await env.DB.prepare("UPDATE tenants SET pix_key = 'chave@teste.com', pix_key_type = 'EMAIL' WHERE id = ?").bind(a.tenantId).run();
    await call('POST', '/api/customers', { token: a.token, body: { name: 'Cliente Um', phone: '11988887777' } });
    await call('PUT', '/api/booking/settings', { token: a.token, body: { enabled: true } });
    const op = await seedUser(a.tenantId);

    const after = (await call('GET', '/api/onboarding', { token: a.token })).json.data;
    expect(after).toMatchObject({ services: true, pix: true, customers: true, booking: true, operator: true, recurring: false, revenue: false });

    const { login } = await import('./helpers.js');
    const opToken = await login(op.email);
    expect((await call('GET', '/api/onboarding', { token: opToken })).status).toBe(403);
    expect((await call('GET', '/api/onboarding')).status).toBe(401);
  });
});
