// Senhas (PBKDF2-SHA256), tokens de sessão e hashes. Usa só Web Crypto: roda no Worker e no Node 20+.
// Formato do hash armazenado: pbkdf2-sha256$<iterações>$<salt base64url>$<hash base64url>

// O runtime dos Workers aceita no máximo 100.000 iterações de PBKDF2.
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compara em tempo constante para não vazar informação pelo tempo de resposta. */
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BITS);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > ITERATIONS) return false;
  const hash = await derive(password, fromBase64Url(parts[2]), iterations);
  return constantTimeEqual(hash, fromBase64Url(parts[3]));
}

let dummyHash;

/**
 * Executa uma verificação de custo equivalente quando o e-mail não existe,
 * para que o tempo de resposta não revele quais contas existem.
 */
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword(crypto.randomUUID());
  await verifyPassword(password, dummyHash);
  return false;
}

/** Token de sessão: 32 bytes aleatórios. Só o SHA-256 dele vai para o banco. */
export function generateToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(value) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}
