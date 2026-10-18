// Convite flutuante para instalar o app na tela inicial (PWA).
// Android/Chrome/Edge: usa o pedido nativo de instalação. iPhone/iPad (Safari): mostra como adicionar.
// Não aparece se o app já está instalado, e some por 7 dias quando a pessoa fecha o aviso.

import { el, icon, openModal } from './ui.js';

const DISMISS_KEY = 'lj.install.dismissedAt';
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

let deferredPrompt = null;
let banner = null;
const listeners = new Set();

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function dismissedRecently() {
  try {
    return Date.now() - Number(localStorage.getItem(DISMISS_KEY) ?? 0) < DISMISS_MS;
  } catch {
    return false;
  }
}

function rememberDismiss() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    // Sem armazenamento (aba anônima): o aviso volta na próxima visita.
  }
}

/** true quando dá para instalar agora (pedido nativo) ou explicar como (iPhone). */
export const canInstall = () => !isStandalone() && (Boolean(deferredPrompt) || isIos());

/** Avisa quando a possibilidade de instalar muda (para mostrar/esconder botões de "Instalar"). */
export function onInstallAvailability(callback) {
  listeners.add(callback);
  callback(canInstall());
}

const notify = () => listeners.forEach((cb) => cb(canInstall()));

function showIosHelp() {
  openModal({
    title: 'Instalar no iPhone',
    content: el('ol', { class: 'install-steps' },
      el('li', {}, 'Abra este site no ', el('strong', {}, 'Safari'), '.'),
      el('li', {}, 'Toque no botão ', el('strong', {}, 'Compartilhar'), ' ', icon('share', 'icon icon-sm'), ' na barra de baixo.'),
      el('li', {}, 'Escolha ', el('strong', {}, 'Adicionar à Tela de Início'), ' e toque em ', el('strong', {}, 'Adicionar'), '.'),
    ),
    actions: [{ label: 'Entendi', variant: 'btn-primary' }],
  });
}

function hideBanner() {
  banner?.remove();
  banner = null;
  document.body.classList.remove('install-open');
}

/** Abre a instalação: pedido nativo do navegador ou instruções do iPhone. */
export async function promptInstall() {
  if (deferredPrompt) {
    const prompt = deferredPrompt;
    deferredPrompt = null;
    prompt.prompt();
    const { outcome } = await prompt.userChoice.catch(() => ({ outcome: 'dismissed' }));
    if (outcome !== 'accepted') rememberDismiss();
    hideBanner();
    notify();
    return;
  }
  if (isIos()) showIosHelp();
}

function showBanner() {
  if (banner || !canInstall() || dismissedRecently()) return;
  const noNav = !document.querySelector('.bottom-nav');
  banner = el('aside', { class: `install-banner${noNav ? ' no-nav' : ''}`, role: 'dialog', 'aria-label': 'Instalar o aplicativo' },
    el('img', { src: 'assets/icons/icon-192.png', alt: '', width: 44, height: 44 }),
    el('div', { class: 'install-banner-text' },
      el('strong', {}, 'Instale o app no celular'),
      el('span', {}, 'Abre direto da tela inicial, mais rápido e em tela cheia.')),
    el('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Agora não', onclick: () => { rememberDismiss(); hideBanner(); } }, icon('close', 'icon icon-sm')),
    el('button', { class: 'btn btn-primary', type: 'button', id: 'install-accept', onclick: () => { promptInstall(); if (isIos()) { rememberDismiss(); hideBanner(); } } },
      icon('download', 'icon icon-sm'), 'Instalar aplicativo'),
  );
  document.body.append(banner);
  document.body.classList.add('install-open');
}

export function setupInstall({ banner: withBanner = true } = {}) {
  if (isStandalone()) return;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // usamos o nosso aviso em vez da barra padrão do navegador
    deferredPrompt = event;
    notify();
    if (withBanner) showBanner();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideBanner();
    notify();
  });
  // No iPhone não existe o evento: mostra o aviso após alguns segundos de uso.
  if (withBanner && isIos()) setTimeout(showBanner, 4000);
}
