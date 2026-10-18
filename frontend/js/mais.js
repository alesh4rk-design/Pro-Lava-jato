// Tela "Mais": menu de cadastros. Mostra no item "Despesas recorrentes" quantos vencimentos chegam nos próximos 3 dias.

import { session } from './app.js';
import { api } from './api.js';

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

loadDueBadge();
