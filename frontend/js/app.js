// Inicialização das páginas autenticadas: guarda de rota, cabeçalho, navegação inferior e PWA.
// Cada página declara no <body>: data-page, data-scope (tenant|system) e opcionalmente data-roles.
// Esta checagem só melhora a experiência; a autorização real é feita pelo Worker.

import { config } from './config.js';
import { getSession, homeFor, SCOPE } from './session.js';
import { logout } from './auth.js';
import { changePassword as changeFirebasePassword } from './firebase.js';
import { api } from './api.js';
import { isStrongPassword } from './format.js';
import { el, icon, field, openModal, toast, setBusy, validateFields } from './ui.js';
import { registerServiceWorker } from './pwa.js';

const NAV = [
  { page: 'dashboard', href: 'dashboard.html', label: 'Início', icon: 'home' },
  { page: 'caixa', href: 'caixa.html', label: 'Caixa', icon: 'wallet' },
  { page: 'lancamento', href: 'lancamento.html', label: 'Lançar', icon: 'plus', main: true },
  { page: 'analise', href: 'analise.html', label: 'Análise', icon: 'chart' },
  { page: 'mais', href: 'mais.html', label: 'Mais', icon: 'menu' },
];

const ROLE_LABEL = { ADMIN: 'Administrador', OPERADOR: 'Operador', SUPER_ADMIN: 'Administrador do sistema' };

function guard() {
  const { scope = SCOPE.TENANT, roles } = document.body.dataset;
  const session = getSession();
  if (!session) {
    location.replace('login.html');
    return null;
  }
  const allowedRoles = roles ? roles.split(',') : null;
  if (session.scope !== scope || (allowedRoles && !allowedRoles.includes(session.user.role))) {
    location.replace(homeFor(session));
    return null;
  }
  return session;
}

function renderHeader(session) {
  const title = session.scope === SCOPE.SYSTEM ? config.APP_NAME : session.tenant?.name ?? config.APP_NAME;
  const initial = (session.user.name || '?').trim().charAt(0).toUpperCase();

  const header = el('header', { class: 'app-header' },
    el('div', { class: 'app-header-title' },
      el('small', {}, session.scope === SCOPE.SYSTEM ? 'Painel de controle' : 'Gestão financeira'),
      el('strong', {}, title),
    ),
    el('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Conta', onclick: () => openAccount(session) },
      el('span', { class: 'avatar' }, initial)),
  );
  document.body.prepend(header);
}

function openAccount(session) {
  const actions = [{ label: 'Sair', variant: 'btn-danger', onClick: () => logout() }];
  if (session.scope === SCOPE.TENANT) {
    actions.unshift({ label: 'Trocar senha', variant: 'btn-outline', onClick: (close) => { close(); openChangePassword(); } });
  }
  openModal({
    title: 'Minha conta',
    content: el('div', { class: 'list' },
      el('div', { class: 'list-row' }, el('span', { class: 'muted' }, 'Nome'), el('strong', {}, session.user.name)),
      el('div', { class: 'list-row' }, el('span', { class: 'muted' }, 'Perfil'), el('strong', {}, ROLE_LABEL[session.user.role] ?? '—')),
    ),
    actions,
  });
}

function openChangePassword() {
  const form = el('form', { class: 'form', novalidate: true },
    field({ id: 'p-current', label: 'Senha atual', type: 'password', autocomplete: 'current-password', maxlength: 128 }),
    field({ id: 'p-new', label: 'Nova senha', type: 'password', autocomplete: 'new-password', maxlength: 128, hint: 'Mínimo de 8 caracteres, com letras e números.' }),
    field({ id: 'p-confirm', label: 'Repita a nova senha', type: 'password', autocomplete: 'new-password', maxlength: 128 }),
  );
  openModal({
    title: 'Trocar senha',
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Salvar',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const [current, next, confirm] = ['p-current', 'p-new', 'p-confirm'].map((id) => form.querySelector(`#${id}`));
          const valid = validateFields([
            [current, (v) => (v ? null : 'Informe a senha atual.')],
            [next, (v) => (isStrongPassword(v) ? null : 'Mínimo de 8 caracteres, com letras e números.')],
            [confirm, (v) => (v === next.value ? null : 'As senhas não conferem.')],
          ]);
          if (!valid) return;
          setBusy(button, true);
          try {
            const idToken = await changeFirebasePassword(session.user.email, current.value, next.value);
            await api.post('/auth/password', { id_token: idToken });
            close();
            toast('Senha alterada. Outros aparelhos foram desconectados.', { type: 'success' });
          } catch (error) {
            toast(error.message, { type: 'error' });
            setBusy(button, false);
          }
        },
      },
    ],
  });
}

function renderNav(current) {
  const nav = el('nav', { class: 'bottom-nav', 'aria-label': 'Navegação principal' },
    NAV.map((item) => el('a', {
      class: `nav-item${item.main ? ' nav-item-main' : ''}`,
      href: item.href,
      'aria-current': item.page === current ? 'page' : false,
    },
    item.main ? el('span', { class: 'nav-bubble' }, icon(item.icon)) : icon(item.icon),
    el('span', {}, item.label))),
  );
  document.body.append(nav);
}

/** Esconde elementos marcados com data-requires-role que o perfil não pode usar. */
function applyRoleVisibility(role) {
  document.querySelectorAll('[data-requires-role]').forEach((node) => {
    node.hidden = !node.dataset.requiresRole.split(',').includes(role);
  });
}

function boot() {
  const session = guard();
  if (!session) return null;
  renderHeader(session);
  if (session.scope === SCOPE.TENANT) renderNav(document.body.dataset.page);
  applyRoleVisibility(session.user.role);
  registerServiceWorker();
  return session;
}

/** Sessão da página atual (null quando a página está redirecionando). */
export const session = boot();
