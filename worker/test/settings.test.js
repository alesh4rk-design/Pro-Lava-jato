import { describe, it, expect } from 'vitest';
import { call, financeFixture, env } from './helpers.js';

describe('configurações', () => {
  it('admin altera o nome e o telefone; a mudança é auditada com antes e depois', async () => {
    const f = await financeFixture();
    const res = await call('PUT', '/api/settings', { token: f.adminToken, body: { business_name: '  Brilho   Total  ', phone: '(11) 98888-7777' } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ business_name: 'Brilho Total', phone: '11988887777' });
    expect((await call('GET', '/api/auth/me', { token: f.adminToken })).json.data.tenant.name).toBe('Brilho Total');
    const log = await env.DB.prepare("SELECT details FROM audit_logs WHERE action = 'SETTINGS_CHANGED' AND tenant_id = ?").bind(f.tenantId).first();
    expect(JSON.parse(log.details).after.business_name).toBe('Brilho Total');
  });

  it('operador não vê nem altera', async () => {
    const f = await financeFixture();
    expect((await call('GET', '/api/settings', { token: f.opToken })).status).toBe(403);
    expect((await call('PUT', '/api/settings', { token: f.opToken, body: { business_name: 'Invadido' } })).status).toBe(403);
  });

  it('valida nome, telefone e campos extras; sem mudança não grava auditoria', async () => {
    const f = await financeFixture();
    const put = (body) => call('PUT', '/api/settings', { token: f.adminToken, body });
    expect((await put({ business_name: 'A' })).status).toBe(400);
    expect((await put({ business_name: 'x'.repeat(81) })).status).toBe(400);
    expect((await put({ phone: '123' })).status).toBe(400);
    expect((await put({ status: 'ATIVO' })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    const current = (await call('GET', '/api/settings', { token: f.adminToken })).json.data.business_name;
    await put({ business_name: current });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'SETTINGS_CHANGED' AND tenant_id = ?").bind(f.tenantId).first();
    expect(n.n).toBe(0);
  });

  it('altera só o próprio lava-jato', async () => {
    const a = await financeFixture();
    const b = await financeFixture();
    await call('PUT', '/api/settings', { token: a.adminToken, body: { business_name: 'Nome do A' } });
    expect((await call('GET', '/api/settings', { token: b.adminToken })).json.data.business_name).not.toBe('Nome do A');
  });
});

describe('chave PIX', () => {
  const put = (f, body) => call('PUT', '/api/settings', { token: f.adminToken, body });
  const get = async (f) => (await call('GET', '/api/settings', { token: f.adminToken })).json.data;

  it('cadastra cada tipo de chave já normalizada', async () => {
    const f = await financeFixture();
    const cases = [
      ['CPF', '529.982.247-25', '52998224725'],
      ['CNPJ', '11.222.333/0001-81', '11222333000181'],
      ['EMAIL', '  Pagamentos@Brilho.COM.br ', 'pagamentos@brilho.com.br'],
      ['TELEFONE', '(11) 98888-7777', '+5511988887777'],
      ['TELEFONE', '+55 11 98888-7777', '+5511988887777'],
      ['ALEATORIA', '123E4567-E89B-12D3-A456-426614174000', '123e4567-e89b-12d3-a456-426614174000'],
    ];
    for (const [type, input, stored] of cases) {
      const res = await put(f, { pix_key_type: type, pix_key: input, pix_holder: 'Brilho Car Ltda' });
      expect(res.status, `${type} ${input}`).toBe(200);
      expect(res.json.data).toMatchObject({ pix_key: stored, pix_key_type: type, pix_holder: 'Brilho Car Ltda' });
    }
    expect(await get(f)).toMatchObject({ pix_key: '123e4567-e89b-12d3-a456-426614174000', pix_key_type: 'ALEATORIA' });
  });

  it('recusa chaves inválidas, tipo errado, tipo sem chave e campos extras', async () => {
    const f = await financeFixture();
    const bad = [
      { pix_key_type: 'CPF', pix_key: '111.111.111-11' }, { pix_key_type: 'CPF', pix_key: '529.982.247-26' }, { pix_key_type: 'CPF', pix_key: '123' },
      { pix_key_type: 'CNPJ', pix_key: '11.222.333/0001-82' }, { pix_key_type: 'CNPJ', pix_key: '00000000000000' },
      { pix_key_type: 'EMAIL', pix_key: 'sem-arroba' }, { pix_key_type: 'EMAIL', pix_key: `${'a'.repeat(70)}@x.com` },
      { pix_key_type: 'TELEFONE', pix_key: '12345' }, { pix_key_type: 'TELEFONE', pix_key: 'abc' },
      { pix_key_type: 'ALEATORIA', pix_key: 'nao-e-uuid' }, { pix_key_type: 'CHAVE', pix_key: '52998224725' }, { pix_key_type: 'CPF' },
      { pix_key: '52998224725' }, { pix_key_type: 'CPF', pix_key: 52998224725 }, { pix_key_type: 'CPF', pix_key: ['52998224725'] },
      { pix_holder: 'x'.repeat(61) }, { pix_key_type: 'CPF', pix_key: '52998224725', tenant_id: 5 },
    ];
    for (const body of bad) expect((await put(f, body)).status, JSON.stringify(body)).toBe(400);
    expect(await get(f)).toMatchObject({ pix_key: '', pix_key_type: '' });
  });

  it('trocar só o tipo valida a chave que já existe; remover limpa chave, tipo e recebedor', async () => {
    const f = await financeFixture();
    await put(f, { pix_key_type: 'CPF', pix_key: '52998224725', pix_holder: 'Maria' });
    expect((await put(f, { pix_key_type: 'CNPJ' })).status).toBe(400);
    expect((await put(f, { pix_holder: 'Maria Souza' })).json.data).toMatchObject({ pix_key: '52998224725', pix_holder: 'Maria Souza' });
    const cleared = await put(f, { pix_key: '' });
    expect(cleared.json.data).toMatchObject({ pix_key: '', pix_key_type: '', pix_holder: '' });
  });

  it('a auditoria registra a troca sem guardar a chave inteira', async () => {
    const f = await financeFixture();
    await put(f, { pix_key_type: 'CPF', pix_key: '52998224725' });
    await put(f, { pix_key_type: 'EMAIL', pix_key: 'pagar@brilho.com' });
    const logs = await env.DB.prepare("SELECT details FROM audit_logs WHERE action = 'SETTINGS_CHANGED' AND tenant_id = ? ORDER BY id").bind(f.tenantId).all();
    expect(logs.results).toHaveLength(2);
    const second = JSON.parse(logs.results[1].details);
    expect(second.before.pix_key).toBe('••••4725');
    expect(second.after.pix_key).toBe('••••.com');
    for (const row of logs.results) {
      expect(row.details).not.toContain('52998224725');
      expect(row.details).not.toContain('pagar@brilho.com');
    }
  });

  it('operador não altera a chave, mas as mensagens prontas já trazem a chave para ele usar', async () => {
    const f = await financeFixture();
    expect((await call('PUT', '/api/settings', { token: f.opToken, body: { pix_key_type: 'CPF', pix_key: '52998224725' } })).status).toBe(403);
    await put(f, { pix_key_type: 'CPF', pix_key: '52998224725', pix_holder: 'Brilho Car' });
    const templates = (await call('GET', '/api/message-templates', { token: f.opToken })).json.data;
    expect(templates.pix).toEqual({ key: '52998224725', type: 'CPF', holder: 'Brilho Car' });
    expect(templates.items.map((t) => t.title)).toContain('Chave PIX');
    expect(templates.items.find((t) => t.title === 'Chave PIX').body).toContain('{pix}');
  });

  it('cada lava-jato tem a própria chave', async () => {
    const a = await financeFixture();
    const b = await financeFixture();
    await put(a, { pix_key_type: 'CPF', pix_key: '52998224725' });
    expect((await get(b)).pix_key).toBe('');
    expect((await call('GET', '/api/message-templates', { token: b.opToken })).json.data.pix.key).toBe('');
  });
});

describe('chave PIX: lava-jatos que já existiam antes da novidade', () => {
  it('a migração acrescenta a mensagem "Chave PIX" só a quem já tinha as mensagens padrão', async () => {
    const f = await financeFixture();
    await call('GET', '/api/message-templates', { token: f.adminToken }); // marca como já recebidas
    const sql = (await import('../migrations/0005_pix.sql?raw')).default;
    const insert = sql.slice(sql.indexOf('INSERT INTO message_templates'));
    await env.DB.prepare("DELETE FROM message_templates WHERE tenant_id = ? AND title = 'Chave PIX'").bind(f.tenantId).run();
    await env.DB.prepare(insert).run();
    const titles = (await call('GET', '/api/message-templates', { token: f.adminToken })).json.data.items.map((t) => t.title);
    expect(titles.filter((t) => t === 'Chave PIX')).toHaveLength(1);
  });
});
