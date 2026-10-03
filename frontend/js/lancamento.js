// Tela Lançar: atalhos grandes para registrar receita ou despesa em poucos toques.

import { session } from './app.js';
import { openRevenueForm } from './receitas.js';
import { openExpenseForm } from './despesas.js';
import { openStockForm } from './estoque.js';

if (session) {
  document.getElementById('new-revenue').addEventListener('click', () => openRevenueForm());
  document.getElementById('new-expense').addEventListener('click', () => openExpenseForm());
  document.getElementById('new-stock').addEventListener('click', () => openStockForm({ isAdmin: session.user.role === 'ADMIN' }));

  // Atalhos do Início (lancamento.html?tipo=receita|despesa) abrem o formulário direto.
  const tipo = new URLSearchParams(location.search).get('tipo');
  if (tipo === 'receita') openRevenueForm();
  if (tipo === 'despesa') openExpenseForm();
}
