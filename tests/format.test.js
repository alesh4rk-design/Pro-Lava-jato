import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCents, parseMoneyToCents, formatBasisPoints, isValidISODate, formatDate, formatDateTime, formatPhone, todayISO, isValidEmail, MAX_CENTS,
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
});

test('parseMoneyToCents evita erro de ponto flutuante', () => {
  // 0.1 + 0.2 em float = 0.30000000000000004; em centavos deve ser exato.
  assert.equal(parseMoneyToCents('0,10') + parseMoneyToCents('0,20'), parseMoneyToCents('0,30'));
  assert.equal(parseMoneyToCents('1,15'), 115);
  assert.equal(parseMoneyToCents('4,35'), 435);
});

test('parseMoneyToCents rejeita entradas inválidas, negativas, zero e gigantes', () => {
  for (const bad of ['', 'abc', '-10', '0', '0,00', '10,555', '1.23,00', '12.3456,00', '1e5', '10.5', '<script>', '1;DROP TABLE', null, undefined, 10]) {
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
