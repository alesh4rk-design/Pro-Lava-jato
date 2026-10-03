import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { call, adminSession, env, unique, ORIGIN } from './helpers.js';
import { hashPassword, verifyPassword } from '../src/lib/crypto.js';

describe('CORS', () => {
  it('preflight de origem permitida recebe os cabeçalhos corretos', async () => {
    const res = await SELF.fetch('https://api.teste/api/auth/login', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('origem não permitida é recusada, sem cabeçalhos CORS', async () => {
    const preflight = await SELF.fetch('https://api.teste/api/auth/login', { method: 'OPTIONS', headers: { Origin: 'https://malicioso.exemplo' } });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const res = await call('POST', '/api/auth/login', { origin: 'https://malicioso.exemplo', body: { email: 'a@b.com', password: 'x' } });
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('nunca usa curinga', async () => {
    const res = await call('GET', '/api/health');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });
});

describe('SQL injection', () => {
  it('payloads no login não autenticam nem quebram o banco', async () => {
    for (const email of ["' OR '1'='1", "admin@x.com' --", "a@b.com'; DROP TABLE users; --"]) {
      const res = await call('POST', '/api/auth/login', { body: { email, password: "' OR '1'='1" } });
      expect(res.status).toBe(401);
    }
    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    expect(users.n).toBeGreaterThanOrEqual(0);
  });

  it('payloads em campos de texto são gravados literalmente', async () => {
    const { token } = await adminSession();
    const name = "Robert'); DROP TABLE users;--";
    const res = await call('POST', '/api/users', { token, body: { name, email: `${unique()}@teste.com`, password: 'senha1234', role: 'OPERADOR' } });
    expect(res.status).toBe(201);
    expect(res.json.data.name).toBe(name);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).toBeTruthy();
  });

  it('filtro de status não aceita SQL', async () => {
    const res = await call('GET', `/api/system/tenants?status=${encodeURIComponent("ATIVO' OR '1'='1")}`, { token: 'a'.repeat(43) });
    expect(res.status).toBe(401);
  });
});

describe('XSS', () => {
  it('texto com HTML volta como dado JSON, nunca como HTML', async () => {
    const { token } = await adminSession();
    const name = '<img src=x onerror=alert(1)>';
    const res = await call('POST', '/api/users', { token, body: { name, email: `${unique()}@teste.com`, password: 'senha1234', role: 'OPERADOR' } });
    expect(res.json.data.name).toBe(name);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('caracteres de controle são removidos', async () => {
    const { token } = await adminSession();
    const res = await call('POST', '/api/users', { token, body: { name: 'Ana\u0000\u0007 Maria', email: `${unique()}@teste.com`, password: 'senha1234', role: 'OPERADOR' } });
    expect(res.json.data.name).toBe('Ana Maria');
  });
});

describe('entrada malformada', () => {
  it('exige JSON', async () => {
    const res = await call('POST', '/api/auth/login', { body: 'email=a', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(res.status).toBe(415);
  });

  it('recusa JSON inválido, array e corpo enorme', async () => {
    expect((await call('POST', '/api/auth/login', { body: '{"email":' })).status).toBe(400);
    expect((await call('POST', '/api/auth/login', { body: '[1,2]' })).status).toBe(400);
    expect((await call('POST', '/api/auth/login', { body: { email: 'a@b.com', password: 'x'.repeat(20_000) } })).status).toBe(413);
  });

  it('senha gigante no login não é processada', async () => {
    const res = await call('POST', '/api/auth/login', { body: { email: 'a@b.com', password: 'x'.repeat(500) } });
    expect(res.status).toBe(401);
  });

  it('tipos errados são recusados', async () => {
    const res = await call('POST', '/api/auth/login', { body: { email: ['a@b.com'], password: { $ne: '' } } });
    expect(res.status).toBe(401);
  });
});

describe('rotas e erros', () => {
  it('rota inexistente → 404 e método errado → 405, em JSON padronizado', async () => {
    const notFound = await call('GET', '/api/nao-existe');
    expect(notFound.status).toBe(404);
    expect(notFound.json).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' } });
    expect((await call('DELETE', '/api/auth/login')).status).toBe(405);
  });

  it('URL malformada não gera erro interno', async () => {
    const { token } = await adminSession();
    expect((await call('PUT', '/api/users/%E0%A4%A', { token, body: {} })).status).toBe(404);
  });

  it('respostas não são cacheáveis e têm cabeçalhos de segurança', async () => {
    const res = await call('GET', '/api/health');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});

describe('hash de senha', () => {
  it('gera hashes diferentes para a mesma senha e verifica corretamente', async () => {
    const a = await hashPassword('senha1234');
    const b = await hashPassword('senha1234');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^pbkdf2-sha256\$100000\$[\w-]{22}\$[\w-]{43}$/);
    expect(await verifyPassword('senha1234', a)).toBe(true);
    expect(await verifyPassword('senha1235', a)).toBe(false);
  });

  it('rejeita hashes adulterados ou com parâmetros fora do limite', async () => {
    const hash = await hashPassword('senha1234');
    const [algo, , salt, digest] = hash.split('$');
    expect(await verifyPassword('senha1234', `${algo}$1000000$${salt}$${digest}`)).toBe(false);
    expect(await verifyPassword('senha1234', `md5$1$${salt}$${digest}`)).toBe(false);
    expect(await verifyPassword('senha1234', 'lixo')).toBe(false);
    expect(await verifyPassword('senha1234', null)).toBe(false);
  });
});
