// Passos do tutorial de primeira vez e cálculo do progresso. Funções puras.

export const STEPS = [
  { key: 'services', title: 'Cadastre seus serviços e preços', text: 'Ex.: Lavagem simples, completa, polimento. O preço já vem preenchido nos lançamentos.', href: 'servicos.html', action: 'Cadastrar serviços' },
  { key: 'pix', title: 'Coloque sua chave PIX', text: 'Ela vai pronta nas mensagens de WhatsApp para o cliente pagar.', href: 'configuracoes.html', action: 'Abrir Configurações' },
  { key: 'customers', title: 'Cadastre ou importe seus clientes', text: 'Dá para importar os contatos do celular de uma vez.', href: 'clientes.html', action: 'Abrir Clientes' },
  { key: 'revenue', title: 'Lance sua primeira receita', text: 'Toque em "Lançar" sempre que terminar uma lavagem.', href: 'lancamento.html?tipo=receita', action: 'Lançar receita' },
  { key: 'recurring', title: 'Cadastre as despesas fixas', text: 'Aluguel, água, luz, internet: o sistema lança e avisa antes de vencer.', href: 'recorrentes.html', action: 'Despesas recorrentes', optional: true },
  { key: 'booking', title: 'Ligue o agendamento online', text: 'Envie o link e o cliente marca o horário sozinho.', href: 'agenda-config.html', action: 'Configurar agendamento', optional: true },
  { key: 'operator', title: 'Adicione um operador', text: 'Quem lava os carros pode lançar receitas sem ver o seu financeiro.', href: 'usuarios.html', action: 'Abrir Usuários', optional: true },
  { key: 'install', title: 'Instale o app no celular', text: 'Fica na tela inicial como um aplicativo.', href: null, action: 'Instalar', optional: true },
];

/** Quantos passos estão feitos e se os obrigatórios acabaram. */
export function progress(done) {
  const total = STEPS.length;
  const count = STEPS.filter((s) => done[s.key]).length;
  const requiredDone = STEPS.filter((s) => !s.optional).every((s) => done[s.key]);
  return { count, total, requiredDone, allDone: count === total };
}

