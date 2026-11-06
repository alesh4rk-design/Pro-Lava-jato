// Leitura de contatos exportados do celular (.vcf do Android/iPhone/Google Contatos e .csv). Funções puras.

/** Remove o que não é número; devolve '' se não parecer celular/telefone brasileiro. */
export function cleanPhone(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('0055')) digits = digits.slice(2);
  if (digits.length >= 12 && digits.startsWith('55')) digits = digits.slice(2);
  return digits.length === 10 || digits.length === 11 ? digits : '';
}

function unfold(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
}

/** vCard (.vcf): um contato por BEGIN:VCARD; usa FN (ou N) e o primeiro telefone válido. */
export function parseVcf(text) {
  const out = [];
  for (const card of unfold(text).split(/BEGIN:VCARD/i).slice(1)) {
    let name = '';
    const phones = [];
    for (const line of card.split('\n')) {
      const m = /^([A-Za-z0-9.\-]+)((?:;[^:]*)?):(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].split('.').pop().toUpperCase();
      if (key === 'FN' && m[3].trim()) name = m[3].trim();
      else if (key === 'N' && !name) name = m[3].split(';').filter(Boolean).reverse().join(' ').trim();
      else if (key === 'TEL') phones.push(m[3]);
    }
    const phone = phones.map(cleanPhone).find(Boolean);
    if (phone) out.push({ name: name || 'Sem nome', phone });
  }
  return out;
}

function splitCsvLine(line, sep) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { cells.push(cur); cur = ''; } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** CSV (Google Contatos, Excel...): acha as colunas de nome e telefone pelo cabeçalho; separador , ou ;. */
export function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = (lines[0].match(/;/g) ?? []).length > (lines[0].match(/,/g) ?? []).length ? ';' : ',';
  const header = splitCsvLine(lines[0], sep).map((h) => h.toLowerCase());
  const nameCols = header.map((h, i) => (/^(name|nome|display name|nome completo|first name|given name|primeiro nome)$/.test(h) ? i : -1)).filter((i) => i >= 0);
  const lastCols = header.map((h, i) => (/^(last name|family name|sobrenome)$/.test(h) ? i : -1)).filter((i) => i >= 0);
  const phoneCols = header.map((h, i) => (/(phone|telefone|celular|mobile|whatsapp)/.test(h) && !/type|tipo|label/.test(h) ? i : -1)).filter((i) => i >= 0);
  if (!phoneCols.length) return [];
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line, sep);
    const phone = phoneCols.flatMap((i) => String(cells[i] ?? '').split(/\s*:::\s*/)).map(cleanPhone).find(Boolean);
    if (!phone) continue;
    const name = [...nameCols, ...lastCols].map((i) => cells[i]).filter(Boolean).join(' ').trim();
    out.push({ name: name || 'Sem nome', phone });
  }
  return out;
}

/** Lê o arquivo conforme a extensão/conteúdo. */
export function parseContacts(fileName, text) {
  return /\.csv$/i.test(fileName) || (!/BEGIN:VCARD/i.test(text) && text.includes(',')) ? parseCsv(text) : parseVcf(text);
}

/** Tira repetidos pelo telefone, mantendo o primeiro. */
export function uniqueByPhone(contacts) {
  const seen = new Set();
  return contacts.filter((c) => !seen.has(c.phone) && seen.add(c.phone));
}
