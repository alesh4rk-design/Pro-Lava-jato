import { describe, it, expect } from 'vitest';
import { isValidCpf, isValidCnpj, normalizePixKey, maskPixKey } from '../src/lib/pix.js';

describe('CPF e CNPJ', () => {
  it('confere os dígitos verificadores', () => {
    for (const ok of ['52998224725', '11144477735', '39053344705']) expect(isValidCpf(ok), ok).toBe(true);
    for (const bad of ['52998224726', '11111111111', '00000000000', '1234567890', '529982247250', 'abcdefghijk', '']) expect(isValidCpf(bad), bad).toBe(false);
    for (const ok of ['11222333000181', '11444777000161', '00000000000191']) expect(isValidCnpj(ok), ok).toBe(true);
    for (const bad of ['11222333000182', '11111111111111', '1122233300018', '']) expect(isValidCnpj(bad), bad).toBe(false);
  });
  it('mascara a chave para a auditoria', () => {
    expect(maskPixKey('52998224725')).toBe('••••4725');
    expect(maskPixKey('')).toBe('(sem chave)');
  });
  it('normaliza e rejeita tipos desconhecidos', () => {
    expect(normalizePixKey('CPF', '529.982.247-25')).toBe('52998224725');
    expect(normalizePixKey('TELEFONE', '11 98888-7777')).toBe('+5511988887777');
    expect(() => normalizePixKey('X', 'abc')).toThrow();
    expect(() => normalizePixKey('CPF', undefined)).toThrow();
  });
});
