// Tradução dos registros de auditoria para frases legíveis.

import { formatCents, formatDate } from './format.js';
import { PAYMENT_LABELS, EXPENSE_TYPE_LABELS } from './entry-form.js';

const ROLE = { ADMIN: 'Administrador', OPERADOR: 'Operador' };
const MOVEMENT = { ENTRADA: 'compra', SAIDA: 'consumo', AJUSTE: 'ajuste de estoque' };

const FIELD_LABELS = {
  amount_cents: 'valor', payment_method: 'pagamento', date: 'data', description: 'descrição', notes: 'observação',
  service_id: 'serviço', category_id: 'categoria', type: 'tipo', name: 'nome', role: 'perfil', active: 'situação',
  price_cents: 'preço', business_name: 'nome do lava-jato', phone: 'telefone', min_stock_qty: 'estoque mínimo', default_expense_type: 'tipo padrão',
};

function fieldValue(field, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (field.endsWith('_cents')) return formatCents(value);
  if (field === 'payment_method') return PAYMENT_LABELS[value] ?? value;
  if (field === 'date') return formatDate(value);
  if (field === 'type' || field === 'default_expense_type') return EXPENSE_TYPE_LABELS[value] ?? value;
  if (field === 'role') return ROLE[value] ?? value;
  if (field === 'active') return value === true || value === 1 ? 'ativo' : 'inativo';
  return String(value);
}

/** "valor: R$ 70,00 → R$ 80,00; pagamento: PIX → Crédito" */
function changes(before = {}, after = {}) {
  return Object.keys(after)
    .map((field) => `${FIELD_LABELS[field] ?? field}: ${fieldValue(field, before[field])} → ${fieldValue(field, after[field])}`)
    .join('; ');
}

const money = (cents) => (Number.isSafeInteger(cents) ? formatCents(Math.abs(cents)) : '');
const withReason = (text, reason) => (reason ? `${text} — motivo: ${reason}` : text);

const DESCRIBE = {
  LOGIN: () => ['Entrou no sistema'],
  LOGIN_FAILED: (d) => ['Tentativa de login recusada', d.email],
  LOGOUT: () => ['Saiu do sistema'],
  PASSWORD_CHANGED: () => ['Trocou a própria senha'],
  PASSWORD_RESET: () => ['Enviou e-mail de redefinição de senha a um usuário'],
  SETTINGS_CHANGED: (d) => ['Alterou as configurações do lava-jato', changes(d.before, d.after)],
  USER_CREATED: (d) => [`Cadastrou o usuário ${d.name}`, `${ROLE[d.role] ?? d.role} · ${d.email}`],
  USER_UPDATED: (d) => ['Alterou um usuário', changes(d.before, d.changes)],
  PERMISSION_CHANGED: (d) => ['Alterou o perfil de um usuário', changes(d.before, d.changes)],
  REVENUE_CREATED: (d) => [`Registrou receita de ${money(d.amount_cents)}`, PAYMENT_LABELS[d.payment_method]],
  REVENUE_UPDATED: (d) => ['Editou uma receita', changes(d.before, d.after)],
  REVENUE_CANCELLED: (d) => [withReason(`Cancelou receita de ${money(d.amount_cents)}`, d.reason), d.date ? `lançada em ${formatDate(d.date)}` : ''],
  EXPENSE_CREATED: (d) => [`Registrou despesa de ${money(d.amount_cents)}`, d.product_purchase ? 'compra de produto' : PAYMENT_LABELS[d.payment_method]],
  EXPENSE_UPDATED: (d) => ['Editou uma despesa', changes(d.before, d.after)],
  EXPENSE_CANCELLED: (d) => [withReason(`Cancelou despesa de ${money(d.amount_cents)}`, d.reason), d.date ? `lançada em ${formatDate(d.date)}` : ''],
  CATEGORY_CREATED: (d) => [`Criou a categoria ${d.name}`],
  CATEGORY_UPDATED: (d) => [`Alterou a categoria ${d.before?.name ?? ''}`.trim(), changes(d.before, d.changes)],
  SERVICE_CREATED: (d) => [`Cadastrou o serviço ${d.name}`, money(d.price_cents)],
  SERVICE_UPDATED: (d) => ['Alterou um serviço', changes(d.before, d.after)],
  SERVICE_PRICE_CHANGED: (d) => ['Alterou o preço de um serviço', changes(d.before, d.after)],
  SERVICE_COSTS_CHANGED: (d) => ['Alterou a composição de custo de um serviço', `${d.items?.length ?? 0} item(ns)`],
  PRODUCT_CREATED: (d) => [`Cadastrou o produto ${d.name}`],
  PRODUCT_UPDATED: (d) => ['Alterou um produto', changes(d.before, d.after)],
  PRODUCT_MOVEMENT: (d) => [withReason(`Registrou ${MOVEMENT[d.type] ?? 'movimentação'} de ${d.product}`, d.reason), d.total_cost_cents ? money(d.total_cost_cents) : ''],
  ACCESS_REQUESTED: (d) => [`Solicitou acesso para ${d.business_name}`, d.email],
  ACCESS_REQUEST_DUPLICATE: (d) => ['Solicitação de acesso com e-mail já cadastrado', d.email],
  TENANT_APPROVED: (d) => [`Autorizou o acesso de ${d.business_name}`],
  TENANT_BLOCKED: (d) => [`Bloqueou o acesso de ${d.business_name}`],
  TENANT_UNBLOCKED: (d) => [`Desbloqueou o acesso de ${d.business_name}`],
  SYSTEM_LOGIN: () => ['Entrou no painel do administrador'],
  SYSTEM_LOGIN_FAILED: (d) => ['Tentativa de login no painel recusada', d.email],
};

/** { actor, title, detail } para um registro da auditoria. */
export function describeAudit(item) {
  const [title, detail = ''] = (DESCRIBE[item.action] ?? (() => [item.action]))(item.details ?? {});
  const actor = item.actor_name ?? (item.actor_type === 'ANONYMOUS' ? 'Visitante (sem login)' : 'Usuário removido');
  return { actor, title, detail: [detail, item.business_name].filter(Boolean).join(' · ') };
}

export const AUDIT_GROUPS = {
  '': 'Tudo',
  LANCAMENTOS: 'Lançamentos',
  ACESSOS: 'Acessos',
  CADASTROS: 'Cadastros',
  ESTOQUE: 'Estoque',
  USUARIOS: 'Usuários',
};
