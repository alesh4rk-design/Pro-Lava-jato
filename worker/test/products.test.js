import { describe, it, expect } from 'vitest';
import { call, financeFixture, seedTenant, seedCategory, env, todayIso } from './helpers.js';

async function createProduct(f, body = {}) {
  const res = await call('POST', '/api/products', { token: f.adminToken, body: { name: `Shampoo ${Math.random()}`, unit: 'ML', min_stock_qty: 1000, ...body } });
  if (res.status !== 201) throw new Error(JSON.stringify(res.json));
  return res.json.data;
}
const move = (f, id, body, token = f.adminToken) => call('POST', `/api/products/${id}/movements`, { token, body });

describe('produtos: cadastro', () => {
  it('admin cadastra; operador não', async () => {
    const f = await financeFixture();
    const product = await createProduct(f, { name: 'Cera líquida', unit: 'ML' });
    expect(product).toMatchObject({ name: 'Cera líquida', unit: 'ML', stock_qty: 0, avg_cost_micro: 0, low_stock: true, active: true });
    expect((await call('POST', '/api/products', { token: f.opToken, body: { name: 'X', unit: 'UN' } })).status).toBe(403);
  });

  it('valida unidade, nome duplicado, categoria e campos extras', async () => {
    const f = await financeFixture();
    await createProduct(f, { name: 'Pano' });
    expect((await call('POST', '/api/products', { token: f.adminToken, body: { name: 'Pano', unit: 'UN' } })).status).toBe(409);
    expect((await call('POST', '/api/products', { token: f.adminToken, body: { name: 'A', unit: 'LITRO' } })).status).toBe(400);
    expect((await call('POST', '/api/products', { token: f.adminToken, body: { name: 'B', unit: 'UN', stock_qty: 999 } })).status).toBe(400);
    // categoria precisa ser de PRODUTO
    expect((await call('POST', '/api/products', { token: f.adminToken, body: { name: 'C', unit: 'UN', category_id: f.categoryId } })).status).toBe(400);
    const productCategory = await seedCategory(f.tenantId, { kind: 'PRODUTO' });
    expect((await call('POST', '/api/products', { token: f.adminToken, body: { name: 'D', unit: 'UN', category_id: productCategory } })).status).toBe(201);
  });

  it('unidade não pode ser alterada depois de criada', async () => {
    const f = await financeFixture();
    const product = await createProduct(f);
    expect((await call('PUT', `/api/products/${product.id}`, { token: f.adminToken, body: { unit: 'G' } })).status).toBe(400);
  });

  it('operador vê estoque, mas não custo', async () => {
    const f = await financeFixture();
    const product = await createProduct(f);
    await move(f, product.id, { type: 'ENTRADA', qty: 5000, total_cost_cents: 8500 });
    const list = await call('GET', '/api/products', { token: f.opToken });
    const item = list.json.data.items.find((p) => p.id === product.id);
    expect(item.stock_qty).toBe(5000);
    expect(item).not.toHaveProperty('avg_cost_micro');
    const detail = await call('GET', `/api/products/${product.id}`, { token: f.opToken });
    expect(detail.json.data.movements[0]).not.toHaveProperty('total_cost_cents');
  });
});

describe('produtos: estoque e custo médio', () => {
  it('compra calcula custo médio ponderado (exemplo do enunciado: 5 L por R$ 85 = R$ 17/L)', async () => {
    const f = await financeFixture();
    const product = await createProduct(f);
    let res = await move(f, product.id, { type: 'ENTRADA', qty: 5000, total_cost_cents: 8500 });
    expect(res.status).toBe(201);
    expect(res.json.data).toMatchObject({ stock_qty: 5000, avg_cost_micro: 17000, low_stock: false });

    res = await move(f, product.id, { type: 'ENTRADA', qty: 5000, total_cost_cents: 10000 });
    expect(res.json.data).toMatchObject({ stock_qty: 10000, avg_cost_micro: 18500 }); // (85 + 100) / 10 L
  });

  it('consumo baixa o estoque e registra o custo (100 ml × R$ 17/L = R$ 1,70)', async () => {
    const f = await financeFixture();
    const product = await createProduct(f);
    await move(f, product.id, { type: 'ENTRADA', qty: 5000, total_cost_cents: 8500 });
    const res = await move(f, product.id, { type: 'SAIDA', qty: 100, reason: 'Lavagem completa' }, f.opToken);
    expect(res.status).toBe(201);
    expect(res.json.data.stock_qty).toBe(4900);
    const detail = await call('GET', `/api/products/${product.id}`, { token: f.adminToken });
    expect(detail.json.data.movements[0]).toMatchObject({ type: 'SAIDA', qty: -100, unit_cost_micro: 17000, total_cost_cents: -170 });
    expect(detail.json.data.avg_cost_micro).toBe(17000); // consumo não muda o custo médio
  });

  it('não permite estoque negativo e não grava nada quando falta estoque', async () => {
    const f = await financeFixture();
    const product = await createProduct(f);
    await move(f, product.id, { type: 'ENTRADA', qty: 100, total_cost_cents: 500 });
    const res = await move(f, product.id, { type: 'SAIDA', qty: 101 });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('INSUFFICIENT_STOCK');
    const counts = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM product_movements WHERE product_id = ?1) AS movements,
              (SELECT COUNT(*) FROM audit_logs WHERE entity = 'product' AND entity_id = ?1 AND action = 'PRODUCT_MOVEMENT') AS audits,
              (SELECT stock_qty FROM products WHERE id = ?1) AS stock`,
    ).bind(product.id).first();
    expect(counts).toEqual({ movements: 1, audits: 1, stock: 100 });
  });

  it('consumos simultâneos nunca passam do estoque', async () => {
    const f = await financeFixture();
    const product = await createProduct(f);
    await move(f, product.id, { type: 'ENTRADA', qty: 100, total_cost_cents: 500 });
    const results = await Promise.all([1, 2, 3].map(() => move(f, product.id, { type: 'SAIDA', qty: 50 })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    const row = await env.DB.prepare('SELECT stock_qty FROM products WHERE id = ?').bind(product.id).first();
    expect(row.stock_qty).toBe(0);
  });

  it('ajuste por contagem: só ADMIN, exige motivo, registra a diferença', async () => {
    const f = await financeFixture();
    const product = await createProduct(f);
    await move(f, product.id, { type: 'ENTRADA', qty: 5000, total_cost_cents: 8500 });
    expect((await move(f, product.id, { type: 'AJUSTE', counted_qty: 4000, reason: 'Contagem' }, f.opToken)).status).toBe(403);
    expect((await move(f, product.id, { type: 'AJUSTE', counted_qty: 4000 })).status).toBe(400);
    expect((await move(f, product.id, { type: 'AJUSTE', counted_qty: 5000, reason: 'Igual' })).status).toBe(409);

    const res = await move(f, product.id, { type: 'AJUSTE', counted_qty: 4000, reason: 'Vazamento' });
    expect(res.json.data.stock_qty).toBe(4000);
    const detail = await call('GET', `/api/products/${product.id}`, { token: f.adminToken });
    expect(detail.json.data.movements[0]).toMatchObject({ type: 'AJUSTE', qty: -1000, total_cost_cents: -1700, reason: 'Vazamento' });
  });

  it('compra pode lançar a despesa no caixa, ligada à movimentação', async () => {
    const f = await financeFixture();
    const product = await createProduct(f, { name: 'Shampoo 5L' });
    const res = await move(f, product.id, {
      type: 'ENTRADA', qty: 5000, total_cost_cents: 8500, register_expense: true,
      payment_method: 'PIX', expense_category_id: f.variableCategoryId,
    }, f.opToken);
    expect(res.status).toBe(201);

    const expense = await env.DB.prepare(
      `SELECT e.amount_cents, e.type, e.description, e.payment_method, m.product_id
         FROM expenses e JOIN product_movements m ON m.id = e.product_movement_id WHERE e.tenant_id = ?`,
    ).bind(f.tenantId).first();
    expect(expense).toEqual({ amount_cents: 8500, type: 'CUSTO_VARIAVEL', description: 'Compra: Shampoo 5L', payment_method: 'PIX', product_id: product.id });

    const audit = await env.DB.prepare("SELECT entity_id FROM audit_logs WHERE tenant_id = ? AND action = 'EXPENSE_CREATED'").bind(f.tenantId).first();
    expect(audit.entity_id).toBeTruthy();

    const cash = await call('GET', '/api/cash?period=today', { token: f.adminToken });
    expect(cash.json.data.totals.out_cents).toBe(8500);
  });

  it('compra com despesa valida categoria e forma de pagamento antes de gravar', async () => {
    const f = await financeFixture();
    const product = await createProduct(f);
    const bad = await move(f, product.id, { type: 'ENTRADA', qty: 10, total_cost_cents: 100, register_expense: true, payment_method: 'PIX', expense_category_id: 99999 });
    expect(bad.status).toBe(400);
    const row = await env.DB.prepare('SELECT stock_qty FROM products WHERE id = ?').bind(product.id).first();
    expect(row.stock_qty).toBe(0);
  });

  it('valida quantidades e valores', async () => {
    const f = await financeFixture();
    const product = await createProduct(f);
    for (const body of [
      { type: 'ENTRADA', qty: 0, total_cost_cents: 100 },
      { type: 'ENTRADA', qty: -5, total_cost_cents: 100 },
      { type: 'ENTRADA', qty: 1.5, total_cost_cents: 100 },
      { type: 'ENTRADA', qty: 2_000_000_000, total_cost_cents: 100 },
      { type: 'ENTRADA', qty: 10, total_cost_cents: -1 },
      { type: 'ENTRADA', qty: 10 },
      { type: 'SAIDA', qty: '10' },
      { type: 'DOACAO', qty: 10 },
    ]) {
      expect((await move(f, product.id, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('produto desativado não recebe movimentações; estoque baixo é filtrável', async () => {
    const f = await financeFixture();
    const product = await createProduct(f, { min_stock_qty: 1000 });
    await move(f, product.id, { type: 'ENTRADA', qty: 500, total_cost_cents: 100 });
    const low = await call('GET', '/api/products?low_stock=1', { token: f.opToken });
    expect(low.json.data.items.map((p) => p.id)).toContain(product.id);

    await call('PUT', `/api/products/${product.id}`, { token: f.adminToken, body: { active: false } });
    expect((await move(f, product.id, { type: 'SAIDA', qty: 1 })).status).toBe(409);
  });

  it('isolamento: não movimenta produto de outro lava-jato', async () => {
    const a = await financeFixture();
    const b = await financeFixture();
    const product = await createProduct(b);
    expect((await move(a, product.id, { type: 'ENTRADA', qty: 10, total_cost_cents: 100 })).status).toBe(404);
    expect((await call('GET', `/api/products/${product.id}`, { token: a.adminToken })).status).toBe(404);
  });
});

describe('serviços', () => {
  it('admin cria e altera preço com auditoria própria; operador só consulta', async () => {
    const f = await financeFixture();
    const created = await call('POST', '/api/services', { token: f.adminToken, body: { name: 'Higienização', price_cents: 18000 } });
    expect(created.status).toBe(201);
    const id = created.json.data.id;
    expect((await call('POST', '/api/services', { token: f.opToken, body: { name: 'X', price_cents: 100 } })).status).toBe(403);
    expect((await call('PUT', `/api/services/${id}`, { token: f.opToken, body: { price_cents: 1 } })).status).toBe(403);
    expect((await call('POST', '/api/services', { token: f.adminToken, body: { name: 'Higienização', price_cents: 100 } })).status).toBe(409);
    expect((await call('POST', '/api/services', { token: f.adminToken, body: { name: 'Y', price_cents: 0 } })).status).toBe(400);

    await call('PUT', `/api/services/${id}`, { token: f.adminToken, body: { price_cents: 19000 } });
    const log = await env.DB.prepare("SELECT details FROM audit_logs WHERE action = 'SERVICE_PRICE_CHANGED' AND entity_id = ?").bind(id).first();
    expect(JSON.parse(log.details)).toEqual({ before: { price_cents: 18000 }, after: { price_cents: 19000 } });

    const opView = await call('GET', `/api/services/${id}`, { token: f.opToken });
    expect(opView.json.data).toEqual({ id, name: 'Higienização', price_cents: 19000, active: true });
  });

  it('composição de custo: produtos pelo custo médio + rateios (exemplo do enunciado)', async () => {
    const f = await financeFixture();
    const shampoo = await createProduct(f, { name: 'Shampoo' });
    const cera = await createProduct(f, { name: 'Cera' });
    await move(f, shampoo.id, { type: 'ENTRADA', qty: 5000, total_cost_cents: 8500 }); // R$ 17/L
    await move(f, cera.id, { type: 'ENTRADA', qty: 1000, total_cost_cents: 5000 }); // R$ 50/L

    const res = await call('PUT', `/api/services/${f.serviceId}/costs`, {
      token: f.adminToken,
      body: { items: [
        { product_id: shampoo.id, qty: 100 }, // R$ 1,70
        { product_id: cera.id, qty: 50 }, // R$ 2,50
        { description: 'Água', fixed_cost_cents: 200 },
        { description: 'Energia', fixed_cost_cents: 120 },
        { description: 'Outros', fixed_cost_cents: 150 },
      ] },
    });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({
      price_cents: 7000, estimated_cost_cents: 890, estimated_margin_cents: 6110, estimated_margin_bp: 8729, has_cost_composition: true,
    });
    expect(res.json.data.costs.map((c) => c.cost_cents)).toEqual([170, 250, 200, 120, 150]);
    expect(res.json.data.costs[0].description).toBe('Shampoo');

    // A receita guarda o custo estimado do momento da venda.
    const revenue = await call('POST', '/api/revenues', { token: f.adminToken, body: { date: todayIso(), service_id: f.serviceId, amount_cents: 7000, payment_method: 'PIX' } });
    expect(revenue.json.data.service_cost_snapshot_cents).toBe(890);
  });

  it('substituir a composição troca todos os itens', async () => {
    const f = await financeFixture();
    await call('PUT', `/api/services/${f.serviceId}/costs`, { token: f.adminToken, body: { items: [{ description: 'Água', fixed_cost_cents: 200 }] } });
    const res = await call('PUT', `/api/services/${f.serviceId}/costs`, { token: f.adminToken, body: { items: [] } });
    expect(res.json.data).toMatchObject({ estimated_cost_cents: 0, has_cost_composition: false, costs: [] });
  });

  it('recusa produto de outro lava-jato e itens inválidos', async () => {
    const f = await financeFixture();
    const other = await financeFixture();
    const foreign = await createProduct(other);
    const put = (items) => call('PUT', `/api/services/${f.serviceId}/costs`, { token: f.adminToken, body: { items } });
    expect((await put([{ product_id: foreign.id, qty: 10 }])).status).toBe(400);
    expect((await put([{ product_id: 1, qty: 0 }])).status).toBe(400);
    expect((await put([{ description: '', fixed_cost_cents: 100 }])).status).toBe(400);
    expect((await put([{ description: 'Água', fixed_cost_cents: -1 }])).status).toBe(400);
    expect((await put(Array.from({ length: 21 }, () => ({ description: 'X', fixed_cost_cents: 1 })))).status).toBe(400);
    expect((await put('nada')).status).toBe(400);
    expect((await put([{ description: 'X', fixed_cost_cents: 1, tenant_id: 1 }])).status).toBe(400);
  });

  it('serviço desativado some da lista do operador e não aceita receitas', async () => {
    const f = await financeFixture();
    await call('PUT', `/api/services/${f.serviceId}`, { token: f.adminToken, body: { active: false } });
    const list = await call('GET', '/api/services', { token: f.opToken });
    expect(list.json.data.items.map((s) => s.id)).not.toContain(f.serviceId);
    const res = await call('POST', '/api/revenues', { token: f.opToken, body: { date: todayIso(), service_id: f.serviceId, amount_cents: 7000, payment_method: 'PIX' } });
    expect(res.status).toBe(400);
  });

  it('lista do admin traz custo e margem estimados; a do operador não', async () => {
    const f = await financeFixture();
    const admin = await call('GET', '/api/services', { token: f.adminToken });
    expect(admin.json.data.items[0]).toHaveProperty('estimated_cost_cents');
    const op = await call('GET', '/api/services', { token: f.opToken });
    expect(op.json.data.items[0]).not.toHaveProperty('estimated_cost_cents');
  });

  it('isolamento: não altera serviço de outro lava-jato', async () => {
    const a = await financeFixture();
    const b = await seedTenant();
    const other = await env.DB.prepare("INSERT INTO services (tenant_id, name, price_cents) VALUES (?, 'Alheio', 100) RETURNING id").bind(b.tenantId).first();
    expect((await call('PUT', `/api/services/${other.id}`, { token: a.adminToken, body: { price_cents: 1 } })).status).toBe(404);
    expect((await call('PUT', `/api/services/${other.id}/costs`, { token: a.adminToken, body: { items: [] } })).status).toBe(404);
  });
});
