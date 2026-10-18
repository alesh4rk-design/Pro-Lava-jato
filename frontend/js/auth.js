// Login, logout e solicitação de acesso.

import { api } from './api.js';
import { saveSession, clearSession, getSession, SCOPE } from './session.js';
import { signIn, signUpOrResume } from './firebase.js';

/** Login do lava-jato (scope tenant) ou do administrador do sistema (scope system). */
export async function login(email, password, scope = SCOPE.TENANT) {
  // Lava-jato: o Firebase confere e-mail e senha e a API só valida o token. Administrador do sistema: senha local.
  const data = scope === SCOPE.SYSTEM
    ? await api.post('/system/auth/login', { email: email.trim().toLowerCase(), password })
    : await api.post('/auth/login', { id_token: await signIn(email, password) });
  const session = { token: data.token, user: data.user, tenant: data.tenant ?? null, scope };
  saveSession(session);
  return session;
}

export async function logout() {
  const session = getSession();
  try {
    if (session) await api.post(session.scope === SCOPE.SYSTEM ? '/system/auth/logout' : '/auth/logout');
  } catch {
    // Mesmo sem resposta do servidor, a sessão local é encerrada.
  } finally {
    clearSession();
    location.replace('login.html');
  }
}

/** Novo lava-jato pede acesso; fica PENDENTE até o administrador do sistema autorizar. */
export async function requestAccess({ businessName, ownerName, email, phone, password }) {
  return api.post('/access-requests', {
    business_name: businessName.trim(),
    owner_name: ownerName.trim(),
    phone: phone.trim(),
    id_token: await signUpOrResume(email, password),
  });
}
