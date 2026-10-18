// Firebase Authentication FALSO, só para os testes de ponta a ponta (imita a API REST e assina tokens RS256).
// Usa as mesmas rotas do emulador oficial do Firebase. A chave pública fica em .wrangler/e2e-jwks.json.
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = 9099;
const PROJECT = 'projeto-e2e';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'e2e', alg: 'RS256', use: 'sig' }] };
mkdirSync(new URL('../../worker/.wrangler/', import.meta.url), { recursive: true });
writeFileSync(new URL('../../worker/.wrangler/e2e-jwks.json', import.meta.url), JSON.stringify(jwks));

const accounts = new Map(); // e-mail → { uid, password }
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function tokenFor(email, authTime = Math.floor(Date.now() / 1000)) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'RS256', kid: 'e2e', typ: 'JWT' })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: accounts.get(email).uid, email, auth_time: authTime, iat: now, exp: now + 3600,
  })}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
}

const fail = (res, message) => res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 400, message } }));
const send = (res, body) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };

createServer((req, res) => {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const action = new URL(req.url, 'http://x').pathname.split('accounts:')[1];
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { return fail(res, 'INVALID_JSON'); }
    const email = String(body.email ?? '').toLowerCase();

    if (action === 'signUp') {
      if (accounts.has(email)) return fail(res, 'EMAIL_EXISTS');
      if (String(body.password ?? '').length < 6) return fail(res, 'WEAK_PASSWORD : Password should be at least 6 characters');
      accounts.set(email, { uid: randomUUID().replaceAll('-', '').slice(0, 28), password: body.password });
      return send(res, { email, localId: accounts.get(email).uid, idToken: tokenFor(email), refreshToken: 'x', expiresIn: '3600' });
    }
    if (action === 'signInWithPassword') {
      const acc = accounts.get(email);
      if (!acc) return fail(res, 'EMAIL_NOT_FOUND');
      if (acc.password !== body.password) return fail(res, 'INVALID_PASSWORD');
      return send(res, { email, localId: acc.uid, idToken: tokenFor(email), refreshToken: 'x', expiresIn: '3600' });
    }
    if (action === 'sendOobCode') {
      if (!accounts.has(email)) return fail(res, 'EMAIL_NOT_FOUND');
      console.log(`[firebase-falso] e-mail de redefinição enviado para ${email}`);
      return send(res, { email });
    }
    if (action === 'update') { // troca de senha: o idToken identifica a conta
      const claims = JSON.parse(Buffer.from(String(body.idToken).split('.')[1] ?? 'e30', 'base64url').toString());
      const acc = accounts.get(claims.email);
      if (!acc) return fail(res, 'INVALID_ID_TOKEN');
      if (String(body.password ?? '').length < 6) return fail(res, 'WEAK_PASSWORD');
      acc.password = body.password;
      return send(res, { email: claims.email, localId: acc.uid, idToken: tokenFor(claims.email, claims.auth_time), refreshToken: 'x' });
    }
    return fail(res, 'OPERATION_NOT_ALLOWED');
  });
}).listen(PORT, '127.0.0.1', () => console.log(`firebase falso em http://127.0.0.1:${PORT}`));
