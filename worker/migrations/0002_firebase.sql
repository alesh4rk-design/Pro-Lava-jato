-- Login dos usuários dos lava-jatos passa a ser feito pelo Firebase Authentication.
-- O banco guarda só o identificador (uid) do Firebase; a senha fica no Firebase.
-- `password_hash` continua existindo (o administrador do sistema ainda usa senha local);
-- para usuários do Firebase ele guarda o texto fixo 'firebase', que nunca confere com nenhuma senha.
ALTER TABLE users ADD COLUMN firebase_uid TEXT;
CREATE UNIQUE INDEX idx_users_firebase_uid ON users (firebase_uid) WHERE firebase_uid IS NOT NULL;
