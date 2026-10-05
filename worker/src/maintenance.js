// Limpeza periódica (Cron Trigger diário). Lançamentos e auditoria nunca são apagados.

const DAY_MS = 86_400_000;
const KEEP_EXPIRED_SESSIONS_DAYS = 7; // mantém um pouco para investigação de incidentes

export async function cleanup(env, now = Date.now()) {
  const cutoff = new Date(now - KEEP_EXPIRED_SESSIONS_DAYS * DAY_MS).toISOString();
  const [sessions, limits] = await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1 OR revoked_at < ?1').bind(cutoff),
    // A maior janela de limite é de 1 hora; contadores de mais de 1 dia já não têm efeito.
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Math.floor(now / 1000) - 86_400),
  ]);
  return { sessions: sessions.meta.changes, rate_limits: limits.meta.changes };
}
