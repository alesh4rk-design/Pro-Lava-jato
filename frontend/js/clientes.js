// Clientes e mensagens prontas de WhatsApp. Clientes: ADMIN e OPERADOR. Mensagens prontas: só o ADMIN edita.
// O app não envia nada sozinho: abre o WhatsApp com a mensagem preenchida e a pessoa toca em enviar.

import { session } from './app.js';
import { api } from './api.js';
import { config } from './config.js';
import { formatPhone, formatDateTime } from './format.js';
import { el, icon, field, toast, openModal, stateView, runBusy, validateFields, setFieldError } from './ui.js';
import { renderMessage, whatsappUrl, vehicleText, PIX_MISSING } from './whatsapp.js';

const isAdmin = session?.user.role === 'ADMIN';
const $ = (id) => document.getElementById(id);
const customerList = $('customer-list');
const templateList = $('template-list');
const search = $('customer-search');
let tab = 'clientes';
let query = '';
let page = 1;
let templatesCache = null;
let pixCache = { key: '', type: '', holder: '' };

const PLACEHOLDER_HELP = [['{nome}', 'Nome do cliente'], ['{veiculo}', 'Modelo e placa'], ['{placa}', 'Placa'], ['{lavajato}', 'Nome do lava-jato'], ['{pix}', 'Chave PIX']];
const SAMPLE = { name: 'Carlos Silva', vehicle: 'Gol branco', plate: 'ABC1D23' };

/* Mensagens prontas -------------------------------------------------------------------- */

async function loadTemplates(force = false) {
  if (!templatesCache || force) {
    const data = await api.get(`/message-templates${isAdmin ? '?include_inactive=1' : ''}`);
    templatesCache = data.items;
    pixCache = data.pix;
  }
  return templatesCache;
}

function openTemplateForm(template = null) {
  const title = field({ id: 't-title', label: 'Título', type: 'text', maxlength: 60, value: template?.title ?? '', placeholder: 'Ex.: Veículo pronto', autocomplete: 'off' });
  const body = el('textarea', { class: 'input', id: 't-body', maxlength: 500, rows: 5, placeholder: 'Olá, {nome}! A limpeza do seu veículo já foi concluída.' }, template?.body ?? '');
  const preview = el('p', { class: 'message-preview', 'aria-live': 'polite' });
  const active = el('input', { type: 'checkbox', id: 't-active', checked: template ? template.active : true });
  const refresh = () => { preview.textContent = renderMessage(body.value, SAMPLE, session.tenant?.name ?? config.APP_NAME, pixCache.key ? pixCache : { key: '52998224725', holder: 'Seu lava-jato' }) || 'A prévia aparece aqui.'; };
  body.addEventListener('input', refresh);
  const insert = (text) => {
    const { selectionStart: start, selectionEnd: end } = body;
    body.setRangeText(text, start, end, 'end');
    body.focus();
    refresh();
  };
  const form = el('form', { class: 'form', novalidate: true },
    title,
    el('div', { class: 'field' },
      el('label', { for: 't-body' }, 'Mensagem'),
      body,
      el('div', { class: 'chips chips-wrap', role: 'group', 'aria-label': 'Inserir campo' },
        PLACEHOLDER_HELP.map(([code, label]) => el('button', { class: 'chip', type: 'button', onclick: () => insert(code) }, code, el('small', { class: 'chip-hint' }, label)))),
      el('span', { class: 'field-error', id: 't-body-error' })),
    el('div', { class: 'field' }, el('span', { class: 'stat-label' }, 'Como o cliente vai ver'), preview),
    template ? el('label', { class: 'switch', for: 't-active' }, 'Mensagem ativa', active) : null,
  );
  refresh();
  openModal({
    title: template ? 'Editar mensagem' : 'Nova mensagem pronta',
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Salvar',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const titleInput = form.querySelector('#t-title');
          const ok = validateFields([
            [titleInput, (v) => (v.trim().length >= 2 ? null : 'Informe o título.')],
            [body, (v) => (v.trim().length >= 2 ? null : 'Escreva a mensagem.')],
          ]);
          if (!ok) return;
          const payload = { title: titleInput.value.trim(), body: body.value.trim() };
          if (template) payload.active = active.checked;
          const saved = await runBusy(button, () => (template
            ? api.put(`/message-templates/${encodeURIComponent(template.id)}`, payload)
            : api.post('/message-templates', payload)));
          if (!saved) return;
          close();
          toast(template ? 'Mensagem atualizada.' : 'Mensagem criada.', { type: 'success' });
          renderTemplates(true);
        },
      },
    ],
  });
}

function templateCard(t) {
  return el('button', { class: 'card tenant-card user-card', type: 'button', onclick: () => openTemplateForm(t), 'aria-label': `Editar mensagem ${t.title}` },
    el('div', { class: 'tenant-card-head' }, el('h3', {}, t.title), t.active ? null : el('span', { class: 'badge' }, 'Inativa')),
    el('p', { class: 'message-body muted' }, t.body),
    el('div', { class: 'tenant-actions' }, el('span', { class: 'edit-chip' }, icon('edit', 'icon icon-sm'), 'Editar')));
}

async function renderTemplates(force = false) {
  templateList.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'skeleton sk-line' })));
  try {
    const items = await loadTemplates(force);
    templateList.replaceChildren(...(items.length ? items.map(templateCard) : [stateView({ title: 'Nenhuma mensagem pronta', message: 'Crie textos como "Veículo pronto" para enviar com um toque.' })]));
  } catch (error) {
    templateList.replaceChildren(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: () => renderTemplates(true) }));
  }
}

/* Enviar mensagem ------------------------------------------------------------------------ */

async function openSend(customer) {
  let templates;
  try {
    templates = (await loadTemplates()).filter((t) => t.active);
  } catch (error) {
    toast(error.message, { type: 'error' });
    return;
  }
  const business = session.tenant?.name ?? config.APP_NAME;
  let chosen = null;
  const text = el('textarea', { class: 'input', id: 'send-text', maxlength: 1000, rows: 6, 'aria-label': 'Mensagem' });
  const hint = el('p', { class: 'hint' }, 'Você pode ajustar o texto antes de abrir o WhatsApp.');
  const pixWarning = el('p', { class: 'hint pix-warning', hidden: true }, `Você ainda não cadastrou a chave PIX. ${isAdmin ? 'Cadastre em Mais → Configurações.' : 'Peça ao administrador para cadastrar.'} Enquanto isso, escreva a chave no texto.`);
  const syncPixWarning = () => { pixWarning.hidden = !(chosen?.body.includes('{pix}') && !pixCache.key); };
  const buttons = templates.map((t) => el('button', {
    class: 'chip', type: 'button', 'aria-pressed': 'false',
    onclick: () => {
      chosen = t;
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === buttons[templates.indexOf(t)])));
      text.value = renderMessage(t.body, customer, business, pixCache);
      syncPixWarning();
    },
  }, t.title));
  if (templates[0]) buttons[0].click();

  openModal({
    title: `Mensagem para ${customer.name}`,
    content: el('div', { class: 'form' },
      el('p', { class: 'muted' }, [formatPhone(customer.phone), vehicleText(customer)].filter(Boolean).join(' · ')),
      templates.length ? el('div', { class: 'field' }, el('span', { class: 'stat-label' }, 'Mensagem pronta'), el('div', { class: 'chips chips-wrap', role: 'group', 'aria-label': 'Mensagens prontas' }, buttons))
        : el('p', { class: 'hint' }, isAdmin ? 'Nenhuma mensagem pronta ativa. Crie na aba "Mensagens prontas" ou escreva abaixo.' : 'Nenhuma mensagem pronta ativa. Escreva abaixo.'),
      el('div', { class: 'field' }, el('label', { for: 'send-text' }, 'Texto'), text, pixWarning, hint)),
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Abrir WhatsApp',
        variant: 'btn-success',
        onClick: (close) => {
          const message = text.value.trim();
          const url = whatsappUrl(customer.phone, message);
          if (!message) { toast('Escreva ou escolha uma mensagem.', { type: 'error' }); return; }
          if (message.includes(PIX_MISSING)) { toast('A chave PIX ainda não foi cadastrada. Escreva a chave no texto antes de enviar.', { type: 'error' }); return; }
          if (!url) { toast('Telefone inválido. Edite o cadastro do cliente.', { type: 'error' }); return; }
          window.open(url, '_blank', 'noopener,noreferrer');
          // Registra o contato (data e auditoria) sem travar a abertura do WhatsApp.
          api.post(`/customers/${encodeURIComponent(customer.id)}/contact`, chosen ? { template_id: chosen.id } : {})
            .then(() => loadCustomers())
            .catch(() => {});
          close();
        },
      },
    ],
  });
}

/* Clientes ----------------------------------------------------------------------------------- */

function openCustomerForm(customer = null) {
  const active = el('input', { type: 'checkbox', id: 'c-active', checked: customer ? customer.active : true });
  const notes = el('textarea', { class: 'input', id: 'c-notes', maxlength: 300, rows: 3 }, customer?.notes ?? '');
  const form = el('form', { class: 'form', novalidate: true },
    field({ id: 'c-name', label: 'Nome', type: 'text', maxlength: 80, value: customer?.name ?? '', autocomplete: 'off' }),
    field({ id: 'c-phone', label: 'Telefone / WhatsApp (com DDD)', type: 'tel', inputmode: 'tel', maxlength: 20, value: customer ? formatPhone(customer.phone) : '', placeholder: '(11) 98888-7777' }),
    field({ id: 'c-vehicle', label: 'Veículo (opcional)', type: 'text', maxlength: 60, value: customer?.vehicle ?? '', placeholder: 'Ex.: Gol branco', autocomplete: 'off' }),
    field({ id: 'c-plate', label: 'Placa (opcional)', type: 'text', maxlength: 8, value: customer?.plate ?? '', placeholder: 'ABC1D23', autocapitalize: 'characters', autocomplete: 'off' }),
    el('div', { class: 'field' }, el('label', { for: 'c-notes' }, 'Observação (opcional)'), notes),
    customer ? el('label', { class: 'switch', for: 'c-active' }, 'Cliente ativo', active) : null,
    customer ? el('p', { class: 'hint' }, 'Desativar esconde o cliente da lista, sem apagar o cadastro.') : null,
  );
  openModal({
    title: customer ? 'Editar cliente' : 'Novo cliente',
    content: form,
    actions: [
      { label: 'Cancelar', variant: 'btn-outline' },
      {
        label: 'Salvar',
        variant: 'btn-primary',
        onClick: async (close, button) => {
          const [name, phone, vehicle, plate] = ['c-name', 'c-phone', 'c-vehicle', 'c-plate'].map((id) => form.querySelector(`#${id}`));
          const digits = phone.value.replace(/\D/g, '');
          const ok = validateFields([
            [name, (v) => (v.trim().length >= 2 ? null : 'Informe o nome.')],
            [phone, () => (digits.length >= 10 && digits.length <= 13 ? null : 'Telefone inválido. Use DDD + número.')],
            [plate, (v) => (!v.trim() || /^[A-Za-z0-9]{5,8}$/.test(v.replace(/[\s-]/g, '')) ? null : 'Placa inválida. Ex.: ABC1D23')],
          ]);
          if (!ok) return;
          const payload = { name: name.value.trim(), phone: phone.value.trim(), vehicle: vehicle.value.trim(), plate: plate.value.trim(), notes: notes.value.trim() };
          if (customer) payload.active = active.checked;
          const saved = await runBusy(button, () => (customer
            ? api.put(`/customers/${encodeURIComponent(customer.id)}`, payload)
            : api.post('/customers', payload)));
          if (!saved) return;
          close();
          toast(customer ? 'Cliente atualizado.' : 'Cliente cadastrado.', { type: 'success' });
          loadCustomers();
        },
      },
    ],
  });
  setFieldError(form.querySelector('#c-name'), null);
}

function customerCard(c) {
  const lastContact = c.last_contact_at ? `Último contato: ${formatDateTime(c.last_contact_at, config.TIMEZONE)}` : 'Ainda sem contato';
  return el('article', { class: `card tenant-card customer-card${c.active ? '' : ' is-inactive'}` },
    el('div', { class: 'tenant-card-head' }, el('h3', {}, c.name), c.active ? null : el('span', { class: 'badge' }, 'Inativo')),
    el('div', { class: 'tenant-meta' },
      el('span', {}, formatPhone(c.phone)),
      vehicleText(c) ? el('span', {}, vehicleText(c)) : null,
      c.notes ? el('span', { class: 'customer-notes' }, c.notes) : null,
      el('span', {}, lastContact)),
    el('div', { class: 'tenant-actions' },
      el('button', { class: 'btn btn-success', type: 'button', onclick: () => openSend(c), disabled: !c.active }, icon('message', 'icon icon-sm'), 'WhatsApp'),
      el('button', { class: 'btn btn-outline', type: 'button', onclick: () => openCustomerForm(c), 'aria-label': `Editar ${c.name}` }, icon('edit', 'icon icon-sm'), 'Editar')));
}

async function loadCustomers({ more = false } = {}) {
  if (more) page += 1; else page = 1;
  if (!more) customerList.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'skeleton sk-line' })));
  try {
    const params = new URLSearchParams({ page: String(page), include_inactive: isAdmin ? '1' : '0' });
    if (query) params.set('q', query);
    const { items, has_more: hasMore } = await api.get(`/customers?${params}`);
    const cards = items.map(customerCard);
    const empty = !items.length && !more;
    const nodes = empty
      ? [stateView({
        title: query ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado',
        message: query ? 'Tente buscar por outro nome, telefone ou placa.' : 'Cadastre seus clientes para avisar pelo WhatsApp quando o veículo estiver pronto.',
        actionLabel: query ? null : 'Cadastrar cliente',
        onAction: query ? null : () => openCustomerForm(),
      })]
      : cards;
    if (more) {
      customerList.querySelector('.load-more')?.remove();
      customerList.append(...nodes);
    } else {
      customerList.replaceChildren(...nodes);
    }
    if (hasMore) customerList.append(el('button', { class: 'btn btn-outline btn-block load-more', type: 'button', onclick: () => loadCustomers({ more: true }) }, 'Carregar mais'));
  } catch (error) {
    customerList.replaceChildren(stateView({ type: 'error', title: 'Não foi possível carregar', message: error.message, actionLabel: 'Tentar novamente', onAction: () => loadCustomers() }));
  }
}

/* Abas e início -------------------------------------------------------------------------------- */

function setTab(next) {
  tab = next;
  document.querySelectorAll('#tabs .chip').forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.tab === tab)));
  $('panel-clientes').hidden = tab !== 'clientes';
  $('panel-mensagens').hidden = tab !== 'mensagens';
  $('new-item-label').textContent = tab === 'clientes' ? 'Novo' : 'Nova';
  if (tab === 'mensagens') renderTemplates();
}

if (session) {
  document.querySelectorAll('#tabs .chip').forEach((chip) => chip.addEventListener('click', () => setTab(chip.dataset.tab)));
  $('new-item').addEventListener('click', () => (tab === 'clientes' ? openCustomerForm() : openTemplateForm()));
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { query = search.value.trim(); loadCustomers(); }, 300);
  });
  loadCustomers();
}
