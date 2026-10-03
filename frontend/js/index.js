// Ponto de entrada: envia para o login ou para a tela inicial do perfil.

import { getSession, homeFor } from './session.js';

const session = getSession();
location.replace(session ? homeFor(session) : 'login.html');
