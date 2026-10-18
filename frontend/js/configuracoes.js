// Configurações do lava-jato (ADMIN): nome exibido no topo e telefone.

import { session } from './app.js';
import { api } from './api.js';
import { getSession, saveSession } from './session.js';
import { formatPhone } from './format.js';
import { toast, runBusy, validateFields, stateView, el, chipGroup, field, confirmDialog, setFieldError, icon } from './ui.js';
import { PIX_TYPE_LABELS, PIX_PLACEHOLDERS, pixError, formatPixKey } from './pix.js';

const $ = (id) => document.getElementById(id);

/** Cadastro da chave PIX: tipo, chave e nome do recebedor. A troca de uma chave já cadastrada pede confirmação. */
function renderPix(data) {
  let saved = { key: data.pix_key, type: data.pix_key_type, holder: data.pix_holder };
  const type = chipGroup({
    label: 'Tipo da chave',
    options: Object.entries(PIX_TYPE_LABELS).map(([value, label]) => ({ value, label })),
    value: saved.type || 'CPF',
    onChange: (opt) => {
      keyInput.placeholder = PIX_PLACEHOLDERS[opt.value];
      keyInput.inputMode = opt.value === 'EMAIL' || opt.value === 'ALEATORIA' ? 'text' : 'numeric';
      setFieldError(keyInput, null);
    },
  });
  const keyField = field({ id: 'pix-key', label: 'Chave PIX', type: 'text', maxlength: 77, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', value: saved.key ? formatPixKey(saved.type, saved.key) : '', placeholder: PIX_PLACEHOLDERS[saved.type || 'CPF'] });
  const keyInput = keyField.querySelector('input');
  const holderField = field({ id: 'pix-holder', label: 'Nome do recebedor (opcional)', type: 'text', maxlength: 60, autocomplete: 'off', value: saved.holder, hint: 'Aparece na mensagem; ajuda o cliente a conferir o nome que o banco mostra.' });
  const holderInput = holderField.querySelector('input');
  const status = el('p', { class: 'hint pix-status' });
  const saveButton = el('button', { class: 'btn btn-primary', type: 'button', id: 'pix-save' }, 'Salvar chave PIX');
  const copyButton = el('button', { class: 'btn btn-outline', type: 'button', id: 'pix-copy' }, icon('message', 'icon icon-sm'), 'Copiar chave');
  const removeButton = el('button', { class: 'btn btn-outline btn-danger-text', type: 'button', id: 'pix-remove' }, 'Remover chave');

  const paint = () => {
    status.textContent = saved.key ? `Chave cadastrada (${PIX_TYPE_LABELS[saved.type]}): ${formatPixKey(saved.type, saved.key)}` : 'Nenhuma chave cadastrada. A mensagem "Chave PIX" fica avisando que falta cadastrar.';
    copyButton.hidden = !saved.key;
    removeButton.hidden = !saved.key;
  };

  saveButton.addEventListener('click', async () => {
    const error = pixError(type.value, keyInput.value);
    setFieldError(keyInput, error);
    if (error) { keyInput.focus(); return; }
    if (saved.key) {
      const ok = await confirmDialog({
        title: 'Trocar a chave PIX?',
        message: 'Os clientes passarão a pagar na nova chave. Confira com atenção: a troca fica registrada na auditoria.',
        confirmLabel: 'Trocar chave',
      });
      if (!ok) return;
    }
    const result = await runBusy(saveButton, () => api.put('/settings', { pix_key_type: type.value, pix_key: keyInput.value.trim(), pix_holder: holderInput.value.trim() }));
    if (!result) return;
    saved = { key: result.pix_key, type: result.pix_key_type, holder: result.pix_holder };
    keyInput.value = formatPixKey(saved.type, saved.key);
    paint();
    toast('Chave PIX salva.', { type: 'success' });
  });

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(saved.key);
      toast('Chave copiada.', { type: 'success' });
    } catch {
      toast('Não foi possível copiar. Selecione e copie o texto do campo.', { type: 'error' });
    }
  });

  removeButton.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Remover a chave PIX?', message: 'A mensagem "Chave PIX" deixa de ter uma chave para enviar até você cadastrar outra.', confirmLabel: 'Remover', danger: true });
    if (!ok) return;
    const result = await runBusy(removeButton, () => api.put('/settings', { pix_key: '' }));
    if (!result) return;
    saved = { key: '', type: '', holder: '' };
    keyInput.value = '';
    holderInput.value = '';
    paint();
    toast('Chave PIX removida.', { type: 'success' });
  });

  $('pix-form').replaceChildren(
    el('div', { class: 'field' }, el('span', { class: 'stat-label' }, 'Tipo da chave'), type.element),
    keyField,
    holderField,
    status,
    el('div', { class: 'tenant-actions' }, saveButton, copyButton),
    removeButton,
  );
  paint();
}

async function init() {
  if (!session) return;
  try {
    const data = await api.get('/settings');
    $('s-name').value = data.business_name;
    $('s-phone').value = formatPhone(data.phone);
    renderPix(data);
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
