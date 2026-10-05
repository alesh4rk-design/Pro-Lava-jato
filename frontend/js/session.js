// Sessão local. O token é opaco: quem decide permissões é sempre o Worker.

// Proteção contra clickjacking: o GitHub Pages não permite o cabeçalho frame-ancestors
// (e ele não funciona em <meta>), então o app se recusa a rodar dentro de um frame de outro site.
// Este módulo é carregado por todas as páginas.
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  try {
    window.top.location.replace(window.self.location.href);
  } catch {
    // navegador bloqueou a navegação do topo: a página continua oculta
  }
}

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
