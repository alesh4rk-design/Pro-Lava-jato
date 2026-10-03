// Gera o SQL para criar (ou redefinir a senha de) um administrador do sistema.
// A senha é lida do terminal sem aparecer na tela nem no histórico do shell.
// Uso:  npm run create-system-admin
//       npx wrangler d1 execute lava-jato-db --remote --file=.admin.sql && rm .admin.sql

import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { hashPassword } from '../src/lib/crypto.js';
import { email as validEmail, newPassword, text } from '../src/lib/validate.js';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

try {
  const name = text(await ask('Nome: '), { field: 'o nome', min: 2, max: 80 });
  const email = validEmail(await ask('E-mail: '));
  const password = newPassword(await ask('Senha (mín. 8, letras e números): ', { hidden: true }));
  if ((await ask('Repita a senha: ', { hidden: true })) !== password) throw new Error('As senhas não conferem.');

  const hash = await hashPassword(password);
  const sql = `INSERT INTO system_admins (name, email, password_hash) VALUES (${sqlString(name)}, ${sqlString(email)}, ${sqlString(hash)})
ON CONFLICT (email) DO UPDATE SET name = excluded.name, password_hash = excluded.password_hash, active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
`;
  writeFileSync('.admin.sql', sql, { mode: 0o600 });
  console.log('\nArquivo .admin.sql gerado (contém apenas o hash, nunca a senha). Execute:');
  console.log('  npx wrangler d1 execute lava-jato-db --remote --file=.admin.sql && rm .admin.sql');
} catch (error) {
  console.error(`Erro: ${error.message}`);
  process.exitCode = 1;
}
