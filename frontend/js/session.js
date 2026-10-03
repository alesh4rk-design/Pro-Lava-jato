// Sessão local. O token é opaco: quem decide permissões é sempre o Worker.

const KEY = 'lj.session';

export const SCOPE = Object.freeze({ TENANT: 'tenant', SYSTEM: 'system' });
export const ROLES = Object.freeze({ ADMIN: 'ADMIN', OPERADOR: 'OPERADOR', SUPER_ADMIN: 'SUPER_ADMIN' });

export function getSession() {
  try {
    const session = JSON.parse(localStorage.getItem(KEY));
    return session?.token && session?.user ? session : null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Armazenamento indisponível (modo privado): a sessão dura só esta página.
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignorado
  }
}

/** Página inicial de acordo com o tipo de acesso. */
export function homeFor(session) {
  return session?.scope === SCOPE.SYSTEM ? 'admin.html' : 'dashboard.html';
}
