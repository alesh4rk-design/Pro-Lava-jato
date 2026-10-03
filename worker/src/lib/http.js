// Respostas JSON padronizadas e erros de API. Mensagens são sempre seguras para o usuário final.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const errors = {
  validation: (message = 'Dados inválidos.') => new ApiError(400, 'VALIDATION_ERROR', message),
  badRequest: (message = 'Requisição inválida.') => new ApiError(400, 'BAD_REQUEST', message),
  unauthenticated: () => new ApiError(401, 'UNAUTHENTICATED', 'Sessão expirada. Entre novamente.'),
  invalidCredentials: () => new ApiError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.'),
  forbidden: () => new ApiError(403, 'FORBIDDEN', 'Você não tem permissão para esta ação.'),
  notFound: (message = 'Recurso não encontrado.') => new ApiError(404, 'NOT_FOUND', message),
  conflict: (message) => new ApiError(409, 'CONFLICT', message),
  invalidState: (message = 'Ação não permitida para a situação atual.') => new ApiError(409, 'INVALID_STATE', message),
  payloadTooLarge: () => new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Requisição muito grande.'),
  unsupportedMedia: () => new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Envie os dados em JSON.'),
  rateLimited: () => new ApiError(429, 'RATE_LIMITED', 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'),
  internal: () => new ApiError(500, 'INTERNAL_ERROR', 'Não foi possível concluir a operação. Tente novamente.'),
};

const SECURITY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, ...extraHeaders } });
}

export const ok = (data, status = 200) => json({ success: true, data }, status);

export const fail = (error) => json({ success: false, error: { code: error.code, message: error.message } }, error.status);

const MAX_BODY_BYTES = 16 * 1024;

/** Lê o corpo como objeto JSON, com limite de tamanho e tipo de conteúdo obrigatório. */
export async function readJson(request) {
  const type = request.headers.get('Content-Type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) throw errors.unsupportedMedia();
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) throw errors.payloadTooLarge();

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw errors.payloadTooLarge();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw errors.badRequest('JSON inválido.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw errors.badRequest('JSON inválido.');
  return body;
}
