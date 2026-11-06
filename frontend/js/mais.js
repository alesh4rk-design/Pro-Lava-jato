// Tela "Mais": menu de cadastros. Mostra no item "Despesas recorrentes" quantos vencimentos chegam nos próximos 3 dias.

import { session } from './app.js';
import { api } from './api.js';
import { showOnboardingAgain } from './primeiros-passos.js';

async function loadDueBadge() {
  if (!session || session.user.role !== 'ADMIN') return;
  try {
    const { items } = await api.get('/recurring-expenses/upcoming?days=3');
    const badge = document.getElementById('due-badge');
    if (!items.length) return;
    badge.textContent = items.length === 1 ? '1 vence logo' : `${items.length} vencem logo`;
    badge.hidden = false;
  } catch {
    // indicação complementar
  }
}

async function loadAgendaBadge() {
  if (!session) return;
  try {
    const { pending } = await api.get('/appointments/summary');
    if (!pending) return;
    const badge = document.getElementById('agenda-badge');
    badge.textContent = pending === 1 ? '1 novo' : `${pending} novos`;
    badge.hidden = false;
  } catch {
    // indicação complementar
  }
}

document.getElementById('show-onboarding')?.addEventListener('click', () => showOnboardingAgain(session?.tenant?.id));

loadDueBadge();
loadAgendaBadge();
