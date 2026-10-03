// Usuários do lava-jato (somente ADMIN): cadastrar operadores, alterar perfil, ativar/desativar e redefinir senha.

import { session } from './app.js';
import { api } from './api.js';
import { config } from './config.js';
import { formatDateTime, isValidEmail, isStrongPassword } from './format.js';
import { el, icon, field, toast, openModal, confirmDialog, stateView, runBusy, validateFields } from './ui.js';

const ROLE_LABEL = { ADMIN: 'Administrador', OPERADOR: 'Operador' };

const list = document.getElementById('user-list');

const nameRule = (v) => (v.trim().length >= 2 ? null : 'Informe o nome.');
const emailRule = (v) => (isValidEmail(v.trim()) ? null : 'Informe um e-mail válido.');
const passwordRule = (v) => (isStrongPassword(v) ? null : 'Mínimo de 8 caracteres, com letras e números.');

function roleSelector(current, disabled) {
  return el('fieldset', { class: 'segmented', 'aria-label': 'Perfil' },
    Object.entries(ROLE_LABEL).map(([value, label]) => el('label', {},
      el('input', { type: 'radio', name: 'role', value, checked: value === current, disabled }),
      label)),
  );
}

const selectedRole = (form) => form.querySelector('input[name="role"]:checked')?.value;

function openCreate() {
  const form = el('form', { class: 'form', novalidate: true },
    field({ id: 'u-name', label: 'Nome', type: 'text', maxlength: 80, autocomplete: 'off' }),
    field({ id: 'u-email', label: 'E-mail (usado no login)', type: 'email', inputmode: 'email', maxlength: 254, autocomplete: 'off' }),
    field({ id: 'u-password', label: 'Senha inicial', type: 'text', maxlength: 128, autocomplete: 'new-password', hint: 'Entregue ao usuário, que pode trocá-la em "Minha conta".' }),
    el('div', { class: 'field' }, el('span', { class: 'stat-label' }, 'Perfil'), roleSelector('OPERADOR', false)),
  );

  openModal({
    title: 'Novo usuário',
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Cadastrar',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const [name, email, password] = ['u-name', 'u-email', 'u-password'].map((id) => form.querySelector(`#${id}`));
          if (!validateFields([[name, nameRule], [email, emailRule], [password, passwordRule]])) return;
          const created = await runBusy(button, () => api.post('/users', {
            name: name.value.trim(),
            email: email.value.trim().toLowerCase(),
            password: password.value,
            role: selectedRole(form),
          }));
          if (created) {
            close();
            toast('Usuário cadastrado.', { type: 'success' });
            load();
          }
        },
      },
    ],
  });
}

function openResetPassword(user) {
  const form = el('form', { class: 'form', novalidate: true },
    el('p', { class: 'muted' }, `Defina uma nova senha para ${user.name}. A sessão aberta nos aparelhos em uso será encerrada.`),
    field({ id: 'r-password', label: 'Nova senha', type: 'text', maxlength: 128, autocomplete: 'new-password' }),
  );
  openModal({
    title: 'Redefinir senha',
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Redefinir',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const input = form.querySelector('#r-password');
          if (!validateFields([[input, passwordRule]])) return;
          const done = await runBusy(button, () => api.post(`/users/${encodeURIComponent(user.id)}/password`, { password: input.value }));
          if (done) {
            close();
            toast('Senha redefinida.', { type: 'success' });
          }
        },
      },
    ],
  });
}

function openEdit(user) {
  const self = user.id === session.user.id;
  const activeInput = el('input', { type: 'checkbox', id: 'e-active', checked: user.active, disabled: self });
  const form = el('form', { class: 'form', novalidate: true },
    field({ id: 'e-name', label: 'Nome', type: 'text', maxlength: 80, value: user.name }),
    el('div', { class: 'field' }, el('span', { class: 'stat-label' }, 'Perfil'), roleSelector(user.role, self)),
    el('label', { class: 'switch', for: 'e-active' }, 'Usuário ativo', activeInput),
    self ? el('p', { class: 'hint' }, 'Você não pode alterar o próprio perfil nem se desativar.') : null,
    self ? null : el('button', { class: 'btn btn-outline btn-block', type: 'button', onclick: () => openResetPassword(user) }, 'Redefinir senha'),
  );

  openModal({
    title: user.email,
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Salvar',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const name = form.querySelector('#e-name');
          if (!validateFields([[name, nameRule]])) return;

          const changes = {};
          if (name.value.trim() !== user.name) changes.name = name.value.trim();
          if (!self && selectedRole(form) !== user.role) changes.role = selectedRole(form);
          if (!self && activeInput.checked !== user.active) changes.active = activeInput.checked;
          if (!Object.keys(changes).length) {
            close();
            return;
          }
          if (changes.active === false && !(await confirmDialog({
            title: 'Desativar usuário?',
            message: `${user.name} será desconectado e não conseguirá mais entrar. O histórico de lançamentos é mantido.`,
            confirmLabel: 'Desativar',
            danger: true,
          }))) return;

          const updated = await runBusy(button, () => api.put(`/users/${encodeURIComponent(user.id)}`, changes));
          if (updated) {
            close();
            toast('Usuário atualizado.', { type: 'success' });
            load();
          }
        },
      },
    ],
  });
}

function userCard(user) {
  const self = user.id === session.user.id;
  return el('button', { class: 'card tenant-card user-card', type: 'button', onclick: () => openEdit(user) },
    el('div', { class: 'tenant-card-head' },
      el('h3', {}, user.name),
      el('span', { class: `badge ${user.active ? 'badge-success' : 'badge-danger'}` }, user.active ? 'Ativo' : 'Inativo'),
    ),
    el('div', { class: 'tenant-meta' },
      el('span', {}, user.email),
      el('span', {}, user.last_login_at ? `Último acesso: ${formatDateTime(user.last_login_at, config.TIMEZONE)}` : 'Ainda não acessou'),
    ),
    el('div', { class: 'tenant-actions' },
      el('span', { class: 'badge badge-primary' }, ROLE_LABEL[user.role] ?? user.role),
      self ? el('span', { class: 'badge' }, 'Você') : null,
      el('span', { class: 'chevron' }, icon('chevron-right', 'icon icon-sm')),
    ),
  );
}

async function load() {
  list.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'skeleton sk-line' }), el('div', { class: 'skeleton sk-value-sm' })));
  try {
    const { items } = await api.get('/users');
    list.replaceChildren(...(items.length ? items.map(userCard) : [stateView({ title: 'Nenhum usuário', message: 'Cadastre o primeiro operador.' })]));
  } catch (error) {
    list.replaceChildren(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: load }));
  }
}

if (session) {
  document.getElementById('new-user').addEventListener('click', openCreate);
  load();
}
