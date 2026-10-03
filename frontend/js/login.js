// Tela de login: entrar (lava-jato), solicitar acesso e entrar como administrador do sistema.

import { config } from './config.js';
import { login, requestAccess } from './auth.js';
import { getSession, homeFor, SCOPE } from './session.js';
import { isValidEmail } from './format.js';
import { setBusy, setFieldError } from './ui.js';
import { registerServiceWorker } from './pwa.js';

const MODES = {
  login: {
    title: config.APP_NAME,
    subtitle: 'Entre para acessar o controle financeiro.',
  },
  system: {
    title: 'Administrador do sistema',
    subtitle: 'Acesso restrito: autorização e bloqueio de clientes.',
  },
  request: {
    title: 'Solicitar acesso',
    subtitle: 'Depois do envio, o administrador do sistema precisa autorizar o seu acesso.',
  },
};

const $ = (id) => document.getElementById(id);
const alertBox = $('form-alert');
let mode = 'login';

function showAlert(message, success = false) {
  alertBox.textContent = message;
  alertBox.classList.toggle('is-success', success);
  alertBox.hidden = !message;
}

function setMode(next) {
  mode = next;
  $('auth').dataset.mode = next;
  $('auth').classList.toggle('auth-mode-system', next === 'system');
  $('auth-title').textContent = MODES[next].title;
  $('auth-subtitle').textContent = MODES[next].subtitle;
  $('login-form').hidden = next === 'request';
  $('request-form').hidden = next !== 'request';
  $('show-request').hidden = next !== 'login';
  $('show-login').hidden = next !== 'request';
  $('toggle-system').hidden = next === 'request';
  $('toggle-system').textContent = next === 'system' ? 'Voltar para o login do lava-jato' : 'Entrar como administrador do sistema';
  showAlert('');
  document.querySelectorAll('.input').forEach((input) => setFieldError(input, ''));
}

/* Validação no cliente: só para orientar o usuário. O Worker valida tudo novamente. */

function validate(rules) {
  let firstInvalid = null;
  for (const [id, check] of rules) {
    const input = $(id);
    const message = check(input.value);
    setFieldError(input, message);
    if (message && !firstInvalid) firstInvalid = input;
  }
  firstInvalid?.focus();
  return !firstInvalid;
}

const required = (label) => (v) => (v.trim() ? null : `Informe ${label}.`);
const emailRule = (v) => (isValidEmail(v.trim()) ? null : 'Informe um e-mail válido.');
const nameRule = (label) => (v) => (v.trim().length >= 2 ? null : `Informe ${label}.`);
const phoneRule = (v) => {
  const digits = v.replace(/\D/g, '');
  return !v.trim() || (digits.length >= 10 && digits.length <= 13) ? null : 'Telefone inválido. Use DDD + número.';
};
const passwordRule = (v) => (v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v) ? null : 'Mínimo de 8 caracteres, com letras e números.');

async function onLogin(event) {
  event.preventDefault();
  showAlert('');
  if (!validate([['login-email', emailRule], ['login-password', required('a senha')]])) return;

  const button = $('login-submit');
  setBusy(button, true);
  try {
    const scope = mode === 'system' ? SCOPE.SYSTEM : SCOPE.TENANT;
    const session = await login($('login-email').value, $('login-password').value, scope);
    location.replace(homeFor(session));
  } catch (error) {
    showAlert(error.message);
    $('login-password').value = '';
    setBusy(button, false);
  }
}

async function onRequest(event) {
  event.preventDefault();
  showAlert('');
  const valid = validate([
    ['req-business', nameRule('o nome do lava-jato')],
    ['req-owner', nameRule('seu nome')],
    ['req-email', emailRule],
    ['req-phone', phoneRule],
    ['req-password', passwordRule],
    ['req-password2', (v) => (v === $('req-password').value ? null : 'As senhas não conferem.')],
  ]);
  if (!valid) return;

  const button = $('request-submit');
  setBusy(button, true);
  try {
    await requestAccess({
      businessName: $('req-business').value,
      ownerName: $('req-owner').value,
      email: $('req-email').value,
      phone: $('req-phone').value,
      password: $('req-password').value,
    });
    $('request-form').reset();
    setMode('login');
    showAlert('Solicitação enviada! Você poderá entrar assim que o administrador autorizar o acesso.', true);
  } catch (error) {
    showAlert(error.message);
  } finally {
    setBusy(button, false);
  }
}

function setupPasswordToggles() {
  document.querySelectorAll('[data-toggle-password]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = $(button.dataset.togglePassword);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
      button.querySelector('use').setAttribute('href', `assets/icons.svg#${show ? 'eye-off' : 'eye'}`);
    });
  });
}

function init() {
  const session = getSession();
  if (session) {
    location.replace(homeFor(session));
    return;
  }
  $('login-form').addEventListener('submit', onLogin);
  $('request-form').addEventListener('submit', onRequest);
  $('show-request').addEventListener('click', () => setMode('request'));
  $('show-login').addEventListener('click', () => setMode('login'));
  $('toggle-system').addEventListener('click', () => setMode(mode === 'system' ? 'login' : 'system'));
  setupPasswordToggles();
  if (new URLSearchParams(location.search).has('expirada')) showAlert('Sua sessão expirou. Entre novamente.');
  registerServiceWorker();
}

init();
