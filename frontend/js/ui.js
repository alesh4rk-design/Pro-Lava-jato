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
        onclick: () => (a.onClick ? a.onClick(close) : close(a.value)),
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
