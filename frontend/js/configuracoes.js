// Configurações do lava-jato (ADMIN): nome exibido no topo e telefone.

import { session } from './app.js';
import { api } from './api.js';
import { getSession, saveSession } from './session.js';
import { formatPhone } from './format.js';
import { toast, runBusy, validateFields, stateView, el } from './ui.js';

const $ = (id) => document.getElementById(id);

async function init() {
  if (!session) return;
  try {
    const data = await api.get('/settings');
    $('s-name').value = data.business_name;
    $('s-phone').value = formatPhone(data.phone);
    $('s-tz').textContent = `Fuso horário: ${data.timezone.replace('_', ' ')} (define o que é "hoje" nos lançamentos e relatórios).`;
  } catch (error) {
    $('settings-form').replaceWith(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: () => location.reload() }));
    return;
  }

  $('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('s-name');
    const phone = $('s-phone');
    const digits = phone.value.replace(/\D/g, '');
    const valid = validateFields([
      [name, (v) => (v.trim().length >= 2 ? null : 'Informe o nome do lava-jato.')],
      [phone, () => (!phone.value.trim() || (digits.length >= 10 && digits.length <= 13) ? null : 'Telefone inválido. Use DDD + número.')],
    ]);
    if (!valid) return;
    const saved = await runBusy($('s-save'), () => api.put('/settings', { business_name: name.value.trim(), phone: phone.value.trim() }));
    if (!saved) return;
    // Atualiza o nome no topo sem precisar sair e entrar de novo.
    const current = getSession();
    if (current) saveSession({ ...current, tenant: { ...current.tenant, name: saved.business_name } });
    document.querySelector('.app-header-title strong')?.replaceChildren(saved.business_name);
    name.value = saved.business_name;
    toast('Configurações salvas.', { type: 'success' });
  });
}

init();
