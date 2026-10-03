// Cliente HTTP único. Todas as chamadas à API passam por aqui.

import { config } from './config.js';
import { getSession, clearSession } from './session.js';

export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const NETWORK_ERROR = new ApiError('NETWORK_ERROR', 'Sem conexão com o servidor. Verifique sua internet.');
const GENERIC_ERROR = 'Não foi possível concluir a operação. Tente novamente.';

async function send(method, path, body) {
  if (config.USE_MOCK) {
    const { handleMock } = await import('./mock.js');
    return handleMock(method, path, body, getSession());
  }

  const headers = { Accept: 'application/json' };
  const token = getSession()?.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(config.API_BASE_URL + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw NETWORK_ERROR;
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Resposta sem JSON válido: tratada abaixo como erro genérico.
  }
  return { status: response.status, payload };
}

async function request(method, path, body) {
  const { status, payload } = await send(method, path, body);

  if (payload?.success === true) return payload.data;

  const code = payload?.error?.code ?? 'UNKNOWN_ERROR';
  if (status === 401 && path !== '/auth/login' && path !== '/system/auth/login') {
    clearSession();
    location.replace('login.html?expirada=1');
  }
  throw new ApiError(code, payload?.error?.message ?? GENERIC_ERROR, status);
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
};
