// Tutorial de primeira vez (só o administrador): passos principais com check que se marca sozinho.

import { api } from './api.js';
import { el, icon } from './ui.js';

import { STEPS, progress } from './primeiros-passos-lista.js';

export { STEPS, progress };

const hiddenKey = (tenantId) => `lj.onboarding.hidden.${tenantId}`;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
};

export const showOnboardingAgain = (tenantId) => store.set(hiddenKey(tenantId), null);

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** Monta o cartão no `container`. `onInstall` abre a instalação do app (quando disponível). */
export async function renderOnboarding(container, { tenantId, onInstall }) {
  if (store.get(hiddenKey(tenantId)) === '1') return;
  let data;
  try {
    data = await api.get('/onboarding');
  } catch {
    return; // complementar: sem o tutorial o Início continua funcionando
  }
  const done = { ...data, install: isStandalone() || store.get('lj.onboarding.install') === '1' };
  const p = progress(done);

  const hide = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, p.requiredDone ? 'Ocultar' : 'Ocultar tutorial');
  hide.addEventListener('click', () => { store.set(hiddenKey(tenantId), '1'); container.hidden = true; });

  const items = STEPS.map((step) => {
    const ok = Boolean(done[step.key]);
    let action = null;
    if (!ok && step.key === 'install') {
      action = el('button', { class: 'btn btn-outline btn-sm', type: 'button' }, step.action);
      action.addEventListener('click', async () => {
        await onInstall?.();
        store.set('lj.onboarding.install', '1');
        renderOnboarding(container, { tenantId, onInstall });
      });
    } else if (!ok) {
      action = el('a', { class: 'btn btn-outline btn-sm', href: step.href }, step.action);
    }
    return el('li', { class: `onb-step${ok ? ' is-done' : ''}` },
      el('span', { class: 'onb-check', 'aria-hidden': 'true' }, ok ? icon('check', 'icon icon-sm') : null),
      el('div', { class: 'onb-body' },
        el('strong', {}, step.title, step.optional ? el('small', { class: 'muted' }, ' (opcional)') : null),
        el('span', { class: 'muted' }, ok ? 'Concluído' : step.text),
        action),
      el('span', { class: 'sr-only' }, ok ? 'concluído' : 'pendente'));
  });

  container.replaceChildren(el('div', { class: 'card onb-card' },
    el('div', { class: 'onb-head' },
      el('div', {},
        el('h2', { class: 'section-title' }, p.requiredDone ? 'Tudo pronto para começar!' : 'Primeiros passos'),
        el('span', { class: 'muted' }, `${p.count} de ${p.total} concluídos`)),
      hide),
    el('div', { class: 'onb-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': p.total, 'aria-valuenow': p.count, 'aria-label': 'Progresso dos primeiros passos' },
      el('span', { class: `onb-fill w-${Math.round((p.count / p.total) * 20) * 5}` })),
    el('ol', { class: 'onb-list' }, items)));
  container.hidden = false;
}
