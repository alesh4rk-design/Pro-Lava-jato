#!/usr/bin/env sh
# API para os testes de ponta a ponta: banco local NOVO a cada execução, com um administrador
# do sistema de teste. Credenciais fictícias, válidas só neste banco descartável.
set -e
cd "$(dirname "$0")/.."
STATE=.wrangler/e2e
rm -rf "$STATE"
npx wrangler d1 migrations apply lava-jato-db --local --persist-to "$STATE" > /dev/null
HASH=$(node --input-type=module -e "import { hashPassword } from './src/lib/crypto.js'; console.log(await hashPassword('Admin12345'))")
npx wrangler d1 execute lava-jato-db --local --persist-to "$STATE" \
  --command "INSERT INTO system_admins (name, email, password_hash) VALUES ('Admin Sistema', 'admin@sistema.test', '$HASH')" > /dev/null
# Firebase falso (tests/e2e/fake-firebase.mjs): grava a chave pública que o Worker usa para conferir os tokens.
JWKS=$(cat .wrangler/e2e-jwks.json)
exec npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to "$STATE" \
  --var ALLOWED_ORIGINS:http://localhost:5173 --var IP_HASH_SALT:e2e \
  --var FIREBASE_PROJECT_ID:projeto-e2e --var "FIREBASE_JWKS_JSON:$JWKS"
