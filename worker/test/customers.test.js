import { describe, it, expect } from 'vitest';
import { call, env, financeFixture, adminSession, seedTenant, seedUser, login } from './helpers.js';

const customer = (overrides = {}) => ({ name: 'João da Silva', phone: '(11) 98888-7777', vehicle: 'Gol branco', plate: 'abc-1d23', notes: 'Prefere lavagem completa', ...overrides });

describe('clientes: cadastro e permissões', () => {
  it('administrador e operador cadastram e editam; visitante não acessa', async () => {
    const f = await financeFixture();
    expect((await call('GET', '/api/customers')).status).toBe(401);
    expect((await call('POST', '/api/customers', { body: customer() })).status).toBe(401);

    for (const token of [f.adminToken, f.opToken]) {
      const res = await call('POST', '/api/customers', { token, body: customer() });
      expect(res.status).toBe(201);
      expect(res.json.data).toMatchObject({ name: 'João da Silva', phone: '11988887777', vehicle: 'Gol branco', plate: 'ABC1D23', active: true, last_contact_at: null });
    }
    const list = await call('GET', '/api/customers', { token: f.opToken });
    expect(list.json.data.items).toHaveLength(2);
  });

  it('edita, desativa e reativa; auditoria não guarda telefone', async () => {
    const f = await financeFixture();
    const created = (await call('POST', '/api/customers', { token: f.opToken, body: customer() })).json.data;
    const edit = await call('PUT', `/api/customers/${created.id}`, { token: f.opToken, body: { name: 'João S. Lima', phone: '11 97777-6666', active: false } });
    expect(edit.status).toBe(200);
    expect(edit.json.data).toMatchObject({ name: 'João S. Lima', phone: '11977776666', active: false });
    expect((await call('GET', '/api/customers', { token: f.adminToken })).json.data.items).toEqual([]);
    expect((await call('GET', '/api/customers?include_inactive=1', { token: f.adminToken })).json.data.items).toHaveLength(1);
    expect((await call('PUT', `/api/customers/${created.id}`, { token: f.adminToken, body: { active: true } })).json.data.active).toBe(true);

    const logs = await env.DB.prepare("SELECT details FROM audit_logs WHERE tenant_id = ? AND entity = 'customer'").bind(f.tenantId).all();
    expect(logs.results.length).toBeGreaterThanOrEqual(3);
    for (const row of logs.results) {
      expect(row.details).not.toMatch(/\d{10}/);
      expect(row.details).not.toContain('Prefere');
    }
  });

  it('valida nome, telefone, placa, textos longos e campos extras', async () => {
    const f = await financeFixture();
    const post = (body) => call('POST', '/api/customers', { token: f.adminToken, body });
    const bad = [
      customer({ name: 'A' }), customer({ name: '' }), customer({ name: 'x'.repeat(81) }), customer({ name: 123 }),
      customer({ phone: '' }), customer({ phone: undefined }), customer({ phone: '123' }), customer({ phone: '1'.repeat(14) }), customer({ phone: 11988887777 }),
      customer({ plate: '!!!' }), customer({ plate: 'A' }), customer({ plate: 'ABCDEFGHIJ' }), customer({ plate: 12345 }),
      customer({ vehicle: 'x'.repeat(61) }), customer({ notes: 'x'.repeat(301) }),
      { ...customer(), tenant_id: 99 }, { ...customer(), active: false }, { ...customer(), last_contact_at: '2020-01-01' },
    ];
    for (const body of bad) expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    expect((await post(customer({ plate: '', vehicle: '', notes: '' }))).status).toBe(201);
    const html = await post(customer({ name: '<img src=x onerror=alert(1)>' }));
    expect(html.json.data.name).toBe('<img src=x onerror=alert(1)>'); // guardado como texto; a tela usa textContent
  });

  it('busca por nome, telefone, placa e veículo, com curingas escapados', async () => {
    const f = await financeFixture();
    const post = (body) => call('POST', '/api/customers', { token: f.adminToken, body });
    await post(customer({ name: 'Maria Souza', phone: '21 99999-1111', vehicle: 'Civic', plate: 'XYZ9K88' }));
    await post(customer({ name: 'Pedro_100%', phone: '31 98888-2222', vehicle: 'Onix', plate: 'AAA1B11' }));
    const q = async (text) => (await call('GET', `/api/customers?q=${encodeURIComponent(text)}`, { token: f.adminToken })).json.data.items.map((i) => i.name);
    expect(await q('maria')).toEqual(['Maria Souza']);
    expect(await q('99999')).toEqual(['Maria Souza']);
    expect(await q('xyz9')).toEqual(['Maria Souza']);
    expect(await q('onix')).toEqual(['Pedro_100%']);
    expect(await q('%')).toEqual(['Pedro_100%']); // o % é procurado como texto, não como curinga
    expect(await q("' OR 1=1 --")).toEqual([]);
  });

  it('paginação e limite de tamanho da busca', async () => {
    const f = await financeFixture();
    for (let i = 0; i < 52; i += 1) await call('POST', '/api/customers', { token: f.adminToken, body: customer({ name: `Cliente ${String(i).padStart(2, '0')}` }) });
    const p1 = (await call('GET', '/api/customers', { token: f.adminToken })).json.data;
    expect(p1.items).toHaveLength(50);
    expect(p1.has_more).toBe(true);
    expect((await call('GET', '/api/customers?page=2', { token: f.adminToken })).json.data.items).toHaveLength(2);
    expect((await call('GET', '/api/customers?page=0', { token: f.adminToken })).status).toBe(400);
    expect((await call('GET', `/api/customers?q=${'x'.repeat(100)}`, { token: f.adminToken })).status).toBe(400);
  });
});

describe('clientes: isolamento entre lava-jatos', () => {
  it('cada lava-jato só vê, edita e contata os próprios clientes', async () => {
    const a = await adminSession();
    const b = await adminSession();
    const mine = (await call('POST', '/api/customers', { token: a.token, body: customer() })).json.data;
    expect((await call('GET', '/api/customers', { token: b.token })).json.data.items).toEqual([]);
    expect((await call('PUT', `/api/customers/${mine.id}`, { token: b.token, body: { name: 'Invasor' } })).status).toBe(404);
    expect((await call('POST', `/api/customers/${mine.id}/contact`, { token: b.token, body: {} })).status).toBe(404);
    const stored = await env.DB.prepare('SELECT name, last_contact_at FROM customers WHERE id = ?').bind(mine.id).first();
    expect(stored).toEqual({ name: 'João da Silva', last_contact_at: null });
  });

  it('IDs malformados e inexistentes', async () => {
    const { token } = await adminSession();
    for (const id of ['abc', '0', '-1', '1.5', '99999999']) expect((await call('PUT', `/api/customers/${id}`, { token, body: { name: 'Nome Teste' } })).status, id).toBe(404);
  });
});

describe('registrar contato', () => {
  it('atualiza o último contato e audita com o título da mensagem, sem telefone', async () => {
    const f = await financeFixture();
    const c = (await call('POST', '/api/customers', { token: f.opToken, body: customer() })).json.data;
    const templates = (await call('GET', '/api/message-templates', { token: f.opToken })).json.data.items;
    const res = await call('POST', `/api/customers/${c.id}/contact`, { token: f.opToken, body: { template_id: templates[0].id } });
    expect(res.status).toBe(200);
    expect(res.json.data.last_contact_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const list = (await call('GET', '/api/customers', { token: f.opToken })).json.data.items;
    expect(list[0].last_contact_at).toBe(res.json.data.last_contact_at);
    const log = await env.DB.prepare("SELECT details FROM audit_logs WHERE action = 'CUSTOMER_CONTACTED' AND entity_id = ?").bind(c.id).first();
    expect(JSON.parse(log.details)).toEqual({ name: 'João da Silva', template: templates[0].title });
    expect((await call('POST', `/api/customers/${c.id}/contact`, { token: f.opToken, body: { template_id: 99999999 } })).status).toBe(400);
    expect((await call('POST', `/api/customers/${c.id}/contact`, { token: f.opToken, body: { outro: 1 } })).status).toBe(400);
    expect((await call('POST', `/api/customers/${c.id}/contact`, { token: f.opToken, body: {} })).status).toBe(200);
  });

  it('não aceita mensagem de outro lava-jato', async () => {
    const a = await adminSession();
    const b = await adminSession();
    const c = (await call('POST', '/api/customers', { token: a.token, body: customer() })).json.data;
    const foreign = (await call('GET', '/api/message-templates', { token: b.token })).json.data.items[0];
    expect((await call('POST', `/api/customers/${c.id}/contact`, { token: a.token, body: { template_id: foreign.id } })).status).toBe(400);
  });
});

describe('mensagens prontas', () => {
  it('cada lava-jato recebe as mensagens padrão uma única vez', async () => {
    const f = await financeFixture();
    const first = (await call('GET', '/api/message-templates', { token: f.opToken })).json.data;
    expect(first.items.length).toBe(6);
    expect(first.items.map((t) => t.title)).toContain('Veículo pronto');
    expect(first.items.every((t) => t.active)).toBe(true);
    expect(first.placeholders).toEqual(['nome', 'veiculo', 'placa', 'lavajato', 'pix']);
    await Promise.all([1, 2, 3].map(() => call('GET', '/api/message-templates', { token: f.adminToken })));
    expect((await call('GET', '/api/message-templates', { token: f.adminToken })).json.data.items).toHaveLength(6);
  });

  it('apagar todas não recria as padrão; só administrador edita', async () => {
    const f = await financeFixture();
    const items = (await call('GET', '/api/message-templates', { token: f.adminToken })).json.data.items;
    expect((await call('PUT', `/api/message-templates/${items[0].id}`, { token: f.opToken, body: { active: false } })).status).toBe(403);
    expect((await call('POST', '/api/message-templates', { token: f.opToken, body: { title: 'Novo', body: 'Olá {nome}' } })).status).toBe(403);
    for (const t of items) expect((await call('PUT', `/api/message-templates/${t.id}`, { token: f.adminToken, body: { active: false } })).status).toBe(200);
    expect((await call('GET', '/api/message-templates', { token: f.adminToken })).json.data.items).toEqual([]);
    expect((await call('GET', '/api/message-templates?include_inactive=1', { token: f.adminToken })).json.data.items).toHaveLength(6);
    expect((await call('GET', '/api/message-templates?include_inactive=1', { token: f.opToken })).json.data.items).toEqual([]); // operador nunca vê as inativas
  });

  it('administrador cria e edita; só campos conhecidos nos textos', async () => {
    const f = await financeFixture();
    const created = await call('POST', '/api/message-templates', { token: f.adminToken, body: { title: 'Aviso de horário', body: 'Olá, {nome}! Hoje fechamos às 18h. — {lavajato}' } });
    expect(created.status).toBe(201);
    const edit = await call('PUT', `/api/message-templates/${created.json.data.id}`, { token: f.adminToken, body: { body: 'Olá {nome}, sua placa {placa} está pronta.' } });
    expect(edit.json.data.body).toBe('Olá {nome}, sua placa {placa} está pronta.');

    const post = (body) => call('POST', '/api/message-templates', { token: f.adminToken, body });
    const bad = [
      { title: 'A', body: 'Olá {nome}' }, { title: 'Ok', body: 'x' }, { title: 'Ok', body: 'Olá {cpf}' }, { title: 'Ok', body: 'Olá {}' }, { title: 'Ok', body: 'Chave {pix_key}' },
      { title: 'x'.repeat(61), body: 'Olá {nome}' }, { title: 'Ok', body: 'x'.repeat(501) }, { title: 'Ok', body: 'Olá {nome}', active: false }, { title: 'Ok' }, { body: 'Olá' },
    ];
    for (const body of bad) expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    expect((await call('PUT', `/api/message-templates/${created.json.data.id}`, { token: f.adminToken, body: {} })).status).toBe(400);
    expect((await call('PUT', '/api/message-templates/99999999', { token: f.adminToken, body: { active: false } })).status).toBe(404);
  });

  it('um lava-jato não altera as mensagens do outro', async () => {
    const a = await adminSession();
    const b = await adminSession();
    const mine = (await call('GET', '/api/message-templates', { token: a.token })).json.data.items[0];
    expect((await call('PUT', `/api/message-templates/${mine.id}`, { token: b.token, body: { title: 'Invasor' } })).status).toBe(404);
    const ids = (await call('GET', '/api/message-templates', { token: b.token })).json.data.items.map((t) => t.id);
    expect(ids).not.toContain(mine.id);
  });
});
