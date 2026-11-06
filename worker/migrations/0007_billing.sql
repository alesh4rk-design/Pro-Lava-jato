-- Mensalidade dos lava-jatos, controlada à mão pelo administrador do sistema.
ALTER TABLE tenants ADD COLUMN plan_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (plan_price_cents BETWEEN 0 AND 100000000);
ALTER TABLE tenants ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'TESTE' CHECK (subscription_status IN ('TESTE', 'ATIVA', 'CANCELADA', 'ISENTA'));
ALTER TABLE tenants ADD COLUMN paid_until TEXT CHECK (paid_until IS NULL OR paid_until GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]');
ALTER TABLE tenants ADD COLUMN subscription_cancelled_at TEXT;
ALTER TABLE tenants ADD COLUMN subscription_cancel_reason TEXT NOT NULL DEFAULT '' CHECK (length(subscription_cancel_reason) <= 200);

-- Quem já usa o sistema ganha 30 dias para você combinar o plano e registrar o primeiro pagamento (ninguém é cortado de surpresa).
UPDATE tenants SET paid_until = date('now', '+30 days') WHERE status IN ('ATIVO', 'BLOQUEADO');

CREATE TABLE subscription_payments (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants (id),
  amount_cents     INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 10000000000),
  months           INTEGER NOT NULL CHECK (months BETWEEN 1 AND 12),
  paid_on          TEXT    NOT NULL CHECK (paid_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  method           TEXT    NOT NULL CHECK (method IN ('PIX', 'DINHEIRO', 'TRANSFERENCIA', 'CARTAO', 'OUTRO')),
  note             TEXT    NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  period_start     TEXT    NOT NULL,                       -- de quando começa a cobertura deste pagamento
  period_end       TEXT    NOT NULL,                       -- "pago até" depois deste pagamento
  prev_paid_until  TEXT,                                   -- para estornar: valor antes do pagamento
  prev_status      TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO', 'ESTORNADO')),
  reversed_at      TEXT,
  reversed_reason  TEXT    NOT NULL DEFAULT '' CHECK (length(reversed_reason) <= 200),
  created_by       INTEGER NOT NULL REFERENCES system_admins (id),
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_payments_tenant ON subscription_payments (tenant_id, status, id);
CREATE INDEX idx_payments_month ON subscription_payments (status, paid_on);
