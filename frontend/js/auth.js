// Login, logout e solicitação de acesso.

import { api } from './api.js';
import { saveSession, clearSession, getSession, SCOPE } from './session.js';

/** Login do lava-jato (scope tenant) ou do administrador do sistema (scope system). */
export async function login(email, password, scope = SCOPE.TENANT) {
  const path = scope === SCOPE.SYSTEM ? '/system/auth/login' : '/auth/login';
  const data = await api.post(path, { email: email.trim().toLowerCase(), password });
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
export function requestAccess({ businessName, ownerName, email, phone, password }) {
  return api.post('/access-requests', {
    business_name: businessName.trim(),
    owner_name: ownerName.trim(),
    email: email.trim().toLowerCase(),
    phone: phone.trim(),
    password,
  });
}
