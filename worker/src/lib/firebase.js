// Verificação do token (ID token) emitido pelo Firebase Authentication.
// O Firebase guarda e-mail e senha; este Worker só confere a assinatura do token (RS256, chaves públicas
// do Google) e depois emite a própria sessão. Nenhuma senha de lava-jato passa por aqui.

import { errors } from './http.js';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CLOCK_SKEW_S = 60;
const MAX_TOKEN_LENGTH = 4096;

let keyCache = { jwks: null, fetchedAt: 0 };

const decoder = new TextDecoder();
const b64urlToBytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const parseJson = (text) => JSON.parse(decoder.decode(b64urlToBytes(text)));

async function loadJwks(env, force = false) {
  // `FIREBASE_JWKS_JSON` só existe nos testes (chaves geradas na hora); em produção vem sempre do Google.
  if (env.FIREBASE_JWKS_JSON) return JSON.parse(env.FIREBASE_JWKS_JSON);
  if (!force && keyCache.jwks && Date.now() - keyCache.fetchedAt < 3600_000) return keyCache.jwks;
  const response = await fetch(JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!response.ok) throw new Error(`JWKS indisponível (${response.status})`);
  keyCache = { jwks: await response.json(), fetchedAt: Date.now() };
  return keyCache.jwks;
}

async function findKey(env, kid) {
  let jwks = await loadJwks(env);
  let jwk = jwks.keys?.find((k) => k.kid === kid);
  if (!jwk && !env.FIREBASE_JWKS_JSON) {
    jwks = await loadJwks(env, true); // o Google troca as chaves de tempos em tempos
    jwk = jwks.keys?.find((k) => k.kid === kid);
  }
  return jwk ?? null;
}

/**
 * Confere assinatura, emissor, público, validade e dono do token.
 * Retorna { uid, email, authTime } ou lança "credenciais inválidas".
 * `maxAuthAgeS`: exige login recente (usado para trocar senha).
 */
export async function verifyFirebaseToken(env, idToken, { maxAuthAgeS = null } = {}) {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID não configurado');
  try {
    if (typeof idToken !== 'string' || idToken.length > MAX_TOKEN_LENGTH) throw new Error('formato');
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('formato');
    const header = parseJson(parts[0]);
    const payload = parseJson(parts[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('algoritmo');

    const jwk = await findKey(env, header.kid);
    if (!jwk) throw new Error('chave desconhecida');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) throw new Error('assinatura');

    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('emissor');
    if (!Number.isFinite(payload.exp) || payload.exp <= now) throw new Error('expirado');
    if (!Number.isFinite(payload.iat) || payload.iat > now + CLOCK_SKEW_S) throw new Error('emitido no futuro');
    if (!Number.isFinite(payload.auth_time) || payload.auth_time > now + CLOCK_SKEW_S) throw new Error('auth_time');
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw new Error('sub');
    if (typeof payload.email !== 'string' || !payload.email) throw new Error('sem e-mail');
    if (maxAuthAgeS !== null && now - payload.auth_time > maxAuthAgeS) throw new Error('login antigo');
    return { uid: payload.sub, email: payload.email.trim().toLowerCase(), authTime: payload.auth_time };
  } catch (error) {
    if (String(error?.message).startsWith('JWKS')) throw error; // falha do Google: erro 500, não "senha errada"
    throw errors.invalidCredentials();
  }
}
