// Firebase Authentication via API REST (sem SDK, sem CDN). O Firebase guarda e-mail e senha e envia o e-mail
// de redefinição; o app só recebe um token que o Worker confere. A chave abaixo é pública por definição.

import { config } from './config.js';

const MESSAGES = {
  EMAIL_EXISTS: 'Este e-mail já está cadastrado.',
  INVALID_LOGIN_CREDENTIALS: 'E-mail ou senha inválidos.',
  INVALID_PASSWORD: 'E-mail ou senha inválidos.',
  EMAIL_NOT_FOUND: 'E-mail ou senha inválidos.',
  USER_DISABLED: 'Esta conta foi desativada.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
  WEAK_PASSWORD: 'Senha fraca. Use no mínimo 8 caracteres, com letras e números.',
  INVALID_EMAIL: 'Informe um e-mail válido.',
  OPERATION_NOT_ALLOWED: 'O login por e-mail e senha não está ativado no Firebase.',
};

export class FirebaseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function call(action, body) {
  let response;
  try {
    response = await fetch(`${config.FIREBASE_AUTH_URL}/accounts:${action}?key=${encodeURIComponent(config.FIREBASE_API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new FirebaseError('NETWORK_ERROR', 'Sem conexão com o servidor. Verifique sua internet.');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = String(payload?.error?.message ?? 'UNKNOWN').split(' ')[0];
    throw new FirebaseError(code, MESSAGES[code] ?? 'Não foi possível concluir a operação. Tente novamente.');
  }
  return payload;
}

const normalize = (email) => email.trim().toLowerCase();

/** Entra com e-mail e senha. Devolve o token (ID token) que o Worker confere. */
export async function signIn(email, password) {
  return (await call('signInWithPassword', { email: normalize(email), password, returnSecureToken: true })).idToken;
}

/** Cria a conta no Firebase. Devolve o token. */
export async function signUp(email, password) {
  return (await call('signUp', { email: normalize(email), password, returnSecureToken: true })).idToken;
}

/**
 * Cadastro que tolera repetição: se a conta já existe no Firebase (ex.: o envio ao servidor falhou antes),
 * tenta entrar com a mesma senha; se a senha for outra, mantém o aviso de e-mail já cadastrado.
 */
export async function signUpOrResume(email, password) {
  try {
    return await signUp(email, password);
  } catch (error) {
    if (error.code !== 'EMAIL_EXISTS') throw error;
    try {
      return await signIn(email, password);
    } catch {
      throw error;
    }
  }
}

/** O Firebase envia o e-mail com o link para a pessoa criar uma nova senha. */
export async function sendPasswordReset(email) {
  await call('sendOobCode', { requestType: 'PASSWORD_RESET', email: normalize(email) });
}

/** Troca a senha. Reautentica com a senha atual (o Firebase exige login recente) e devolve o token novo. */
export async function changePassword(email, currentPassword, newPassword) {
  const idToken = await signIn(email, currentPassword);
  const updated = await call('update', { idToken, password: newPassword, returnSecureToken: true });
  return updated.idToken;
}
