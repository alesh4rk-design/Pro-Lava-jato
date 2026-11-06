import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleText, whenText } from '../frontend/js/recorrentes-text.js';
import {
  formatCents, parseMoneyToCents, centsToInput, formatQty, parseQty, formatUnitCost, formatBasisPoints, isValidISODate, formatDate, formatDateTime, formatPhone, todayISO, isValidEmail, MAX_CENTS,
} from '../frontend/js/format.js';

test('formatCents usa padrão brasileiro e aritmética inteira', () => {
  assert.equal(formatCents(1845000), 'R$\u00a018.450,00');
  assert.equal(formatCents(7050), 'R$\u00a070,50');
  assert.equal(formatCents(5), 'R$\u00a00,05');
  assert.equal(formatCents(0), 'R$\u00a00,00');
  assert.equal(formatCents(-802000), '-R$\u00a08.020,00');
  assert.equal(formatCents(123456789012), 'R$\u00a01.234.567.890,12');
});

test('formatCents rejeita valores que não são inteiros seguros', () => {
  assert.equal(formatCents(70.5), '—');
  assert.equal(formatCents('7050'), '—');
  assert.equal(formatCents(NaN), '—');
  assert.equal(formatCents(Number.MAX_SAFE_INTEGER + 1), '—');
});

test('parseMoneyToCents converte formatos aceitos', () => {
  assert.equal(parseMoneyToCents('70,50'), 7050);
  assert.equal(parseMoneyToCents('70,5'), 7050);
  assert.equal(parseMoneyToCents('40'), 4000);
  assert.equal(parseMoneyToCents('1.234,56'), 123456);
  assert.equal(parseMoneyToCents('1234,56'), 123456);
  assert.equal(parseMoneyToCents(' R$ 18.450,00 '), 1845000);
  assert.equal(parseMoneyToCents('0,01'), 1);
  // teclado com ponto decimal
  assert.equal(parseMoneyToCents('10.5'), 1050);
  assert.equal(parseMoneyToCents('10.50'), 1050);
  assert.equal(parseMoneyToCents('1.234'), 123400);
});

test('centsToInput', () => {
  assert.equal(centsToInput(7050), '70,50');
  assert.equal(centsToInput(5), '0,05');
  assert.equal(centsToInput(0), '');
  assert.equal(parseMoneyToCents(centsToInput(123456)), 123456);
});

test('parseMoneyToCents evita erro de ponto flutuante', () => {
  // 0.1 + 0.2 em float = 0.30000000000000004; em centavos deve ser exato.
  assert.equal(parseMoneyToCents('0,10') + parseMoneyToCents('0,20'), parseMoneyToCents('0,30'));
  assert.equal(parseMoneyToCents('1,15'), 115);
  assert.equal(parseMoneyToCents('4,35'), 435);
});

test('parseMoneyToCents rejeita entradas inválidas, negativas, zero e gigantes', () => {
  for (const bad of ['', 'abc', '-10', '0', '0,00', '10,555', '1.23,00', '12.3456,00', '1e5', '10.555.5', '1.5.5', '<script>', '1;DROP TABLE', null, undefined, 10]) {
    assert.equal(parseMoneyToCents(bad), null, `deveria rejeitar ${String(bad)}`);
  }
  assert.equal(parseMoneyToCents('100.000.000,00'), MAX_CENTS);
  assert.equal(parseMoneyToCents('100.000.000,01'), null);
  assert.equal(parseMoneyToCents('99999999999999999999'), null);
});

test('formatBasisPoints', () => {
  assert.equal(formatBasisPoints(4350), '43,5%');
  assert.equal(formatBasisPoints(4347), '43,5%');
  assert.equal(formatBasisPoints(-1200), '-12,0%');
  assert.equal(formatBasisPoints(null), '—');
});

test('isValidISODate valida o calendário real', () => {
  assert.equal(isValidISODate('2026-10-03'), true);
  assert.equal(isValidISODate('2024-02-29'), true);
  assert.equal(isValidISODate('2026-02-29'), false);
  assert.equal(isValidISODate('2026-13-01'), false);
  assert.equal(isValidISODate('2026-04-31'), false);
  assert.equal(isValidISODate('03/10/2026'), false);
  assert.equal(isValidISODate("2026-10-03' OR 1=1"), false);
  assert.equal(isValidISODate(20261003), false);
});

test('formatDate e todayISO', () => {
  assert.equal(formatDate('2026-10-03'), '03/10/2026');
  assert.equal(formatDate('lixo'), '—');
  // 02:30 UTC do dia 4 ainda é dia 3 em São Paulo (UTC-3).
  assert.equal(todayISO('America/Sao_Paulo', new Date('2026-10-04T02:30:00Z')), '2026-10-03');
  assert.equal(todayISO('America/Sao_Paulo', new Date('2026-10-04T03:30:00Z')), '2026-10-04');
});

test('formatDateTime converte UTC para o fuso do lava-jato', () => {
  assert.equal(formatDateTime('2026-10-03T14:05:00.000Z', 'America/Sao_Paulo'), '03/10/2026 11:05');
  assert.equal(formatDateTime('2026-10-04T02:30:00.000Z', 'America/Sao_Paulo', { time: false }), '03/10/2026');
  assert.equal(formatDateTime('lixo', 'America/Sao_Paulo'), '—');
  assert.equal(formatDateTime(null, 'America/Sao_Paulo'), '—');
});

test('formatPhone', () => {
  assert.equal(formatPhone('11988887777'), '(11) 98888-7777');
  assert.equal(formatPhone('1133334444'), '(11) 3333-4444');
  assert.equal(formatPhone('5511988887777'), '(11) 98888-7777');
  assert.equal(formatPhone(''), '');
});

test('isValidEmail', () => {
  assert.equal(isValidEmail('dono@lavajato.com.br'), true);
  assert.equal(isValidEmail('sem-arroba.com'), false);
  assert.equal(isValidEmail('a b@c.com'), false);
  assert.equal(isValidEmail('<script>alert(1)</script>@x.com'), false);
  assert.equal(isValidEmail("x'--@x.com"), false);
  assert.equal(isValidEmail('joao.silva+caixa@sub.dominio.com.br'), true);
  assert.equal(isValidEmail(`${'a'.repeat(250)}@x.com`), false);
});

test('formatQty mostra L/kg acima de 1000', () => {
  assert.equal(formatQty(20000, 'ML'), '20 L');
  assert.equal(formatQty(2500, 'ML'), '2,5 L');
  assert.equal(formatQty(500, 'ML'), '500 ml');
  assert.equal(formatQty(-1000, 'ML'), '-1 L');
  assert.equal(formatQty(1250, 'G'), '1,25 kg');
  assert.equal(formatQty(12, 'UN'), '12 un');
  assert.equal(formatQty(1.5, 'ML'), '—');
});

test('parseQty converte para a menor unidade', () => {
  assert.equal(parseQty('5', 1000), 5000);
  assert.equal(parseQty('2,5', 1000), 2500);
  assert.equal(parseQty('0.125', 1000), 125);
  assert.equal(parseQty('100', 1), 100);
  assert.equal(parseQty('0,5', 1), null); // meio ml não existe
  assert.equal(parseQty('0', 1), null);
  assert.equal(parseQty('0', 1, { allowZero: true }), 0);
  for (const bad of ['', '-5', 'abc', '1,2345', '1e3', '2000000', '1.000.000']) {
    assert.equal(parseQty(bad, 1000), null, bad);
  }
});

test('formatUnitCost (R$ 85 por 5 L = R$ 17/L)', () => {
  assert.equal(formatUnitCost(17000, 'ML'), 'R$\u00a017,00/L');
  assert.equal(formatUnitCost(25000, 'G'), 'R$\u00a025,00/kg');
  assert.equal(formatUnitCost(1_500_000, 'UN'), 'R$\u00a01,50/un');
});


test('textos das despesas recorrentes', () => {
  assert.equal(scheduleText({ frequency: 'DIARIA' }), 'Todo dia');
  assert.equal(scheduleText({ frequency: 'SEMANAL', weekday: 1 }), 'Toda segunda');
  assert.equal(scheduleText({ frequency: 'MENSAL', month_day: 5 }), 'Todo dia 5');
  assert.equal(scheduleText({ frequency: 'MENSAL', month_day: 31 }), 'Todo último dia do mês');
  assert.deepEqual([0, 1, 2, 7].map(whenText), ['hoje', 'amanhã', 'em 2 dias', 'em 7 dias']);
});

import { whatsappNumber, vehicleText, renderMessage, whatsappUrl } from '../frontend/js/whatsapp.js';

test('whatsappNumber: acrescenta 55, aceita 55 já presente e rejeita o resto', () => {
  assert.equal(whatsappNumber('11988887777'), '5511988887777');
  assert.equal(whatsappNumber('1133334444'), '551133334444');
  assert.equal(whatsappNumber('5511988887777'), '5511988887777');
  assert.equal(whatsappNumber('(11) 98888-7777'), '5511988887777');
  for (const bad of ['', '123', '119888877', '99999999999999', null, undefined, '4411988887777']) assert.equal(whatsappNumber(bad), '', String(bad));
});

test('renderMessage: troca os campos e não deixa buracos quando faltam dados', () => {
  const body = 'Olá, {nome}! A limpeza do seu veículo {veiculo} já foi concluída. — {lavajato}';
  assert.equal(renderMessage(body, { name: 'João', vehicle: 'Gol', plate: 'ABC1D23' }, 'Brilho Car'),
    'Olá, João! A limpeza do seu veículo (Gol · ABC1D23) já foi concluída. — Brilho Car');
  assert.equal(renderMessage(body, { name: 'João' }, 'Brilho Car'), 'Olá, João! A limpeza do seu veículo já foi concluída. — Brilho Car');
  assert.equal(renderMessage('Oi {nome}, placa {placa}.', { name: 'Ana', plate: 'XYZ9K88' }), 'Oi Ana, placa XYZ9K88.');
  assert.equal(renderMessage('Oi, {nome}! — {lavajato}', { name: 'Ana' }, ''), 'Oi, Ana!');
  assert.equal(renderMessage('{cpf} {nome}', { name: 'Ana' }), '{cpf} Ana'); // campo desconhecido não é trocado
  assert.equal(vehicleText({ vehicle: 'Civic' }), 'Civic');
  assert.equal(vehicleText({ plate: 'AAA1B11' }), 'AAA1B11');
});

test('whatsappUrl: só dígitos no número e texto codificado (sem injetar parâmetros)', () => {
  const url = whatsappUrl('(11) 98888-7777', 'Olá & tchau? #1 a=b\nlinha 2');
  assert.equal(url, 'https://wa.me/5511988887777?text=Ol%C3%A1%20%26%20tchau%3F%20%231%20a%3Db%0Alinha%202');
  assert.equal(whatsappUrl('abc', 'oi'), '');
  assert.equal(new URL(url).host, 'wa.me');
});

import { isValidCpf, isValidCnpj, pixError, formatPixKey } from '../frontend/js/pix.js';
import { PIX_MISSING, pixText } from '../frontend/js/whatsapp.js';

test('chave PIX: CPF, CNPJ e demais tipos', () => {
  assert.equal(isValidCpf('52998224725'), true);
  assert.equal(isValidCpf('52998224726'), false);
  assert.equal(isValidCpf('11111111111'), false);
  assert.equal(isValidCnpj('11222333000181'), true);
  assert.equal(isValidCnpj('11222333000182'), false);
  assert.equal(pixError('CPF', '529.982.247-25'), null);
  assert.match(pixError('CPF', '123'), /CPF incorreto/);
  assert.equal(pixError('CNPJ', '11.222.333/0001-81'), null);
  assert.equal(pixError('EMAIL', 'pagar@brilho.com.br'), null);
  assert.match(pixError('EMAIL', 'sem arroba'), /inválido/);
  assert.equal(pixError('TELEFONE', '(11) 98888-7777'), null);
  assert.equal(pixError('TELEFONE', '+55 11 98888-7777'), null);
  assert.match(pixError('TELEFONE', '12345'), /inválido/);
  assert.equal(pixError('ALEATORIA', '123e4567-e89b-12d3-a456-426614174000'), null);
  assert.match(pixError('ALEATORIA', 'xyz'), /inválida/);
  assert.match(pixError('CPF', ''), /Informe/);
  assert.match(pixError('X', 'abc'), /tipo/);
  assert.equal(formatPixKey('CPF', '52998224725'), '529.982.247-25');
  assert.equal(formatPixKey('CNPJ', '11222333000181'), '11.222.333/0001-81');
  assert.equal(formatPixKey('TELEFONE', '+5511988887777'), '(11) 98888-7777');
  assert.equal(formatPixKey('EMAIL', 'a@b.com'), 'a@b.com');
});

test('mensagem com {pix}: chave, recebedor e aviso quando falta cadastrar', () => {
  const body = 'Olá, {nome}! Chave PIX do {lavajato}:\n\n{pix}\n\nObrigado!';
  const customer = { name: 'Ana' };
  assert.equal(renderMessage(body, customer, 'Brilho', { key: '52998224725', holder: 'Brilho Car' }),
    'Olá, Ana! Chave PIX do Brilho:\n\n52998224725\nRecebedor: Brilho Car\n\nObrigado!');
  assert.equal(renderMessage(body, customer, 'Brilho', { key: 'pagar@x.com' }), 'Olá, Ana! Chave PIX do Brilho:\n\npagar@x.com\n\nObrigado!');
  assert.ok(renderMessage(body, customer, 'Brilho').includes(PIX_MISSING));
  assert.equal(pixText({ key: '', holder: 'X' }), PIX_MISSING);
});

import { nameFromSearch } from '../frontend/js/cliente-busca.js';

test('cliente novo na hora: o que foi digitado vira nome, menos telefone ou placa', () => {
  assert.equal(nameFromSearch('  Maria Souza '), 'Maria Souza');
  assert.equal(nameFromSearch('ABC1D23'), '');
  assert.equal(nameFromSearch('11 98888-7777'), '');
  assert.equal(nameFromSearch(''), '');
});

import { addMonths as addMonthsFront, nextPaidUntil, stateBadge, dueLine, collectionMessage, subscriptionNotice } from '../frontend/js/cobranca.js';

test('cobrança: contas de data iguais às do servidor', () => {
  assert.equal(addMonthsFront('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsFront('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonthsFront('2026-11-15', 3), '2027-02-15');
  assert.equal(nextPaidUntil({ paidUntil: '2026-11-10', today: '2026-10-18', months: 1 }), '2026-12-10'); // ainda vale: soma ao vencimento
  assert.equal(nextPaidUntil({ paidUntil: '2026-09-01', today: '2026-10-18', months: 1 }), '2026-11-18'); // já venceu: conta de hoje
  assert.equal(nextPaidUntil({ paidUntil: null, today: '2026-10-18', months: 2 }), '2026-12-18');
});

test('cobrança: selos, linha de vencimento e mensagem', () => {
  const b = (state, days_left, paid_until = '2026-10-25', access = true) => ({ state, days_left, paid_until, access });
  assert.deepEqual(stateBadge(b('EM_DIA', 30)), { label: 'Em dia', tone: 'badge-success' });
  assert.equal(stateBadge(b('VENCENDO', 0)).label, 'Vence hoje');
  assert.equal(stateBadge(b('VENCENDO', 1)).label, 'Vence em 1 dia');
  assert.equal(stateBadge(b('VENCENDO', 4)).label, 'Vence em 4 dias');
  assert.equal(stateBadge(b('EM_ATRASO', -1)).label, 'Atrasada há 1 dia');
  assert.equal(stateBadge(b('EM_ATRASO', -3)).label, 'Atrasada há 3 dias');
  assert.equal(stateBadge(b('VENCIDA', -9)).tone, 'badge-danger');
  assert.equal(stateBadge(b('TESTE', 3)).label, 'Teste até 25/10');
  assert.equal(stateBadge(b('CANCELADA', 7)).label, 'Cancelada · acesso até 25/10');
  assert.equal(stateBadge(b('CANCELADA', -2, '2026-10-25', false)).label, 'Cancelada · sem acesso');
  assert.equal(stateBadge(b('ISENTA', null, null)).label, 'Isenta');
  assert.equal(dueLine(b('EM_DIA', 7)), 'Pago até 25/10/2026 · faltam 7 dias');
  assert.equal(dueLine(b('EM_ATRASO', -2)), 'Pago até 25/10/2026 · venceu há 2 dias');
  assert.equal(dueLine(b('TESTE', 0)), 'Teste até 25/10/2026 · vence hoje');
  assert.equal(dueLine(b('ISENTA', null, null)), '');

  const overdue = collectionMessage({ owner: 'Carlos Silva', business: 'Brilho Car', billing: b('EM_ATRASO', -2, '2026-10-16'), priceCents: 14990 });
  assert.ok(overdue.startsWith('Olá, Carlos!'));
  assert.ok(overdue.includes('venceu em 16/10/2026'));
  assert.ok(overdue.replace(/\u00a0/g, ' ').includes('R$ 149,90')); // o formatador usa espaço não quebrável
  assert.ok(!collectionMessage({ owner: '', business: 'X', billing: b('VENCENDO', 0, '2026-10-18'), priceCents: 0 }).includes('Valor:'));
});

test('aviso de mensalidade para o administrador do lava-jato', () => {
  const sub = (state, days_left, paid_until = '2026-10-25') => ({ state, days_left, paid_until });
  assert.equal(subscriptionNotice(sub('EM_DIA', 20)), null);
  assert.equal(subscriptionNotice(sub('ISENTA', null, null)), null);
  assert.equal(subscriptionNotice(sub('TESTE', 6)), null);
  assert.equal(subscriptionNotice(undefined), null);
  assert.deepEqual(subscriptionNotice(sub('VENCENDO', 0)), { urgent: true, text: 'Sua mensalidade vence hoje.' });
  assert.equal(subscriptionNotice(sub('VENCENDO', 4)).urgent, false);
  assert.match(subscriptionNotice(sub('EM_ATRASO', -2)).text, /Regularize para não perder o acesso/);
  assert.match(subscriptionNotice(sub('TESTE', 2)).text, /teste termina em 2 dias/);
  assert.match(subscriptionNotice(sub('CANCELADA', 5)).text, /até 25\/10\/2026/);
});
