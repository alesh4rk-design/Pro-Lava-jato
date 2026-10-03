// Componentes de interface. Todo texto entra via textContent: nunca usar innerHTML com dados.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Cria um elemento: el('p', { class: 'muted' }, 'texto', outroNode). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

/** Ícone do sprite assets/icons.svg. */
export function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `assets/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

/* Toasts */

let toastRegion;

export function toast(message, { type = 'info', action, duration = 3500 } = {}) {
  if (!toastRegion) {
    toastRegion = el('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRegion);
  }
  const item = el('div', { class: `toast toast-${type}` }, el('span', { class: 'dot' }), el('span', {}, message));
  const close = () => item.remove();
  if (action) {
    item.append(el('button', { class: 'btn', type: 'button', onclick: () => { close(); action.onClick(); } }, action.label));
  }
  toastRegion.append(item);
  if (duration > 0) setTimeout(close, duration);
  return close;
}

/* Modal (bottom sheet) baseado em <dialog> */

export function openModal({ title, content, actions = [], onClose }) {
  const dialog = el('dialog', { class: 'modal', 'aria-label': title });
  const close = (value) => dialog.close(value ?? '');

  dialog.append(
    el('div', { class: 'modal-head' },
      el('h2', {}, title),
      el('button', { class: 'btn btn-icon', type: 'button', 'aria-label': 'Fechar', onclick: () => close() }, icon('close')),
    ),
    el('div', { class: 'modal-body' }, content),
  );
  if (actions.length) {
    dialog.append(el('div', { class: 'modal-actions' },
      actions.map((a) => el('button', {
        class: `btn btn-lg ${a.variant ?? ''}`,
        type: 'button',
        onclick: (e) => (a.onClick ? a.onClick(close, e.currentTarget) : close(a.value)),
      }, a.label)),
    ));
  }

  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  dialog.addEventListener('close', () => { onClose?.(dialog.returnValue); dialog.remove(); });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

/** Confirmação para ações destrutivas. Resolve true/false. */
export function confirmDialog({ title, message, confirmLabel = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      title,
      content: el('p', {}, message),
      actions: [
        { label: 'Voltar', variant: 'btn-outline', value: 'no' },
        { label: confirmLabel, variant: danger ? 'btn-danger' : 'btn-primary', value: 'yes' },
      ],
      onClose: (value) => resolve(value === 'yes'),
    });
  });
}

/* Estados */

export function setBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
}

/** Estado vazio ou de erro, com ação opcional (ex.: "Tentar novamente"). */
export function stateView({ type = 'empty', title, message, actionLabel, onAction }) {
  return el('div', { class: `state state-${type}`, role: type === 'error' ? 'alert' : null },
    el('div', { class: 'state-icon' }, icon(type === 'error' ? 'alert' : 'inbox')),
    el('h3', {}, title),
    message ? el('p', { class: 'muted' }, message) : null,
    actionLabel ? el('button', { class: 'btn btn-outline', type: 'button', onclick: onAction }, icon('refresh', 'icon icon-sm'), actionLabel) : null,
  );
}

/** Marca campo como inválido e mostra a mensagem logo abaixo dele. */
export function setFieldError(input, message) {
  const errorEl = document.getElementById(`${input.id}-error`);
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  if (errorEl) errorEl.textContent = message ?? '';
}

/**
 * Valida campos: rules = [[input, (valor) => mensagemDeErro | null], ...].
 * Mostra os erros, foca o primeiro campo inválido e retorna true se tudo estiver certo.
 * Serve só para orientar o usuário: o servidor valida tudo novamente.
 */
export function validateFields(rules) {
  let firstInvalid = null;
  for (const [input, check] of rules) {
    const message = check(input.value);
    setFieldError(input, message);
    if (message && !firstInvalid) firstInvalid = input;
  }
  firstInvalid?.focus();
  return !firstInvalid;
}

/** Campo de formulário com rótulo, dica opcional e área de erro. */
export function field({ id, label, hint, ...inputAttrs }) {
  return el('div', { class: 'field' },
    el('label', { for: id }, label),
    el('input', { class: 'input', id, ...inputAttrs }),
    hint ? el('span', { class: 'hint' }, hint) : null,
    el('span', { class: 'field-error', id: `${id}-error` }),
  );
}

/**
 * Grupo de chips de escolha única (forma de pagamento, serviço, categoria...).
 * options: [{ value, label, hint? }]. Retorna { element, get value(), set value(v) }.
 */
export function chipGroup({ label, options, value, onChange }) {
  let current = value;
  const buttons = options.map((opt) => el('button', {
    class: 'chip',
    type: 'button',
    'aria-pressed': String(opt.value === current),
    onclick: () => {
      current = opt.value;
      buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].value === current)));
      onChange?.(opt);
    },
  }, opt.label, opt.hint ? el('small', { class: 'chip-hint' }, opt.hint) : null));
  const element = el('div', { class: 'chips chips-wrap', role: 'group', 'aria-label': label }, buttons);
  return {
    element,
    get value() { return current; },
    set value(v) {
      current = v;
      buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].value === current)));
    },
  };
}

/** Executa a requisição com o botão em carregamento; erro do servidor vira toast. Retorna null se falhar. */
export async function runBusy(button, request) {
  setBusy(button, true);
  try {
    return await request();
  } catch (error) {
    toast(error.message, { type: 'error' });
    return null;
  } finally {
    setBusy(button, false);
  }
}
