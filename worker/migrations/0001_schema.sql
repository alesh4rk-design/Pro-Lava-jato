-- Schema inicial. Convenções:
--   * dinheiro em centavos (INTEGER); custo unitário de insumo em micro-reais (1 real = 1.000.000)
--   * quantidades de produto na menor unidade (ml, g, un) como INTEGER
--   * datas de negócio 'YYYY-MM-DD'; carimbos de tempo ISO-8601 UTC
--   * todo dado de lava-jato leva tenant_id; chaves estrangeiras compostas (tenant_id, id)
--     impedem, no próprio banco, ligar registros de lava-jatos diferentes
--   * registros financeiros não são apagados: status ATIVO/CANCELADO
--   * o D1 aplica chaves estrangeiras sempre (equivale a PRAGMA foreign_keys = ON)

-- Plataforma -----------------------------------------------------------------

CREATE TABLE system_admins (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  email         TEXT    NOT NULL UNIQUE CHECK (length(email) <= 254),
  password_hash TEXT    NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE tenants (
  id            INTEGER PRIMARY KEY,
  business_name TEXT    NOT NULL CHECK (length(business_name) BETWEEN 2 AND 80),
  phone         TEXT    NOT NULL DEFAULT '' CHECK (length(phone) <= 20),
  status        TEXT    NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'ATIVO', 'BLOQUEADO')),
  approved_by   INTEGER REFERENCES system_admins (id),
  approved_at   TEXT,
  blocked_at    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_tenants_status ON tenants (status, created_at);

-- Usuários e sessões ------------------------------------------------------------

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants (id),
  name          TEXT    NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  email         TEXT    NOT NULL UNIQUE CHECK (length(email) <= 254),
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('ADMIN', 'OPERADOR')),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_login_at TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id)
);

CREATE INDEX idx_users_tenant ON users (tenant_id, active);

-- Uma sessão pertence a um usuário de lava-jato OU a um administrador do sistema.
-- Só o SHA-256 do token é armazenado.
CREATE TABLE sessions (
  id              INTEGER PRIMARY KEY,
  token_hash      TEXT    NOT NULL UNIQUE,
  user_id         INTEGER REFERENCES users (id),
  tenant_id       INTEGER REFERENCES tenants (id),
  system_admin_id INTEGER REFERENCES system_admins (id),
  expires_at      TEXT    NOT NULL,
  last_seen_at    TEXT    NOT NULL,
  revoked_at      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((user_id IS NOT NULL AND tenant_id IS NOT NULL AND system_admin_id IS NULL)
      OR (user_id IS NULL AND tenant_id IS NULL AND system_admin_id IS NOT NULL))
);

CREATE INDEX idx_sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_tenant ON sessions (tenant_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

CREATE TABLE rate_limits (
  key          TEXT    PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- Cadastros -------------------------------------------------------------------------

CREATE TABLE categories (
  id                   INTEGER PRIMARY KEY,
  tenant_id            INTEGER NOT NULL REFERENCES tenants (id),
  name                 TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  kind                 TEXT    NOT NULL CHECK (kind IN ('DESPESA', 'PRODUTO')),
  default_expense_type TEXT    CHECK (default_expense_type IN ('CUSTO_VARIAVEL', 'DESPESA_FIXA', 'OUTRA')),
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, kind, name),
  UNIQUE (tenant_id, id)
);

CREATE TABLE services (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants (id),
  name        TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  price_cents INTEGER NOT NULL CHECK (price_cents BETWEEN 0 AND 10000000000),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);

CREATE TABLE products (
  id             INTEGER PRIMARY KEY,
  tenant_id      INTEGER NOT NULL REFERENCES tenants (id),
  category_id    INTEGER,
  name           TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  unit           TEXT    NOT NULL CHECK (unit IN ('ML', 'G', 'UN')),
  stock_qty      INTEGER NOT NULL DEFAULT 0,
  min_stock_qty  INTEGER NOT NULL DEFAULT 0 CHECK (min_stock_qty >= 0),
  avg_cost_micro INTEGER NOT NULL DEFAULT 0 CHECK (avg_cost_micro >= 0),
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id)
);

CREATE TABLE product_movements (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants (id),
  product_id       INTEGER NOT NULL,
  type             TEXT    NOT NULL CHECK (type IN ('ENTRADA', 'SAIDA', 'AJUSTE')),
  qty              INTEGER NOT NULL CHECK (qty <> 0),
  unit_cost_micro  INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_micro >= 0),
  total_cost_cents INTEGER NOT NULL DEFAULT 0,
  reason           TEXT    NOT NULL DEFAULT '' CHECK (length(reason) <= 200),
  user_id          INTEGER NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);

CREATE INDEX idx_movements_product ON product_movements (tenant_id, product_id, created_at);

-- Composição estimada do custo de um serviço: consumo de produto OU valor fixo rateado.
CREATE TABLE service_costs (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL REFERENCES tenants (id),
  service_id       INTEGER NOT NULL,
  product_id       INTEGER,
  description      TEXT    NOT NULL CHECK (length(description) BETWEEN 1 AND 60),
  qty              INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  fixed_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (fixed_cost_cents >= 0),
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, service_id) REFERENCES services (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  CHECK ((product_id IS NOT NULL AND qty > 0 AND fixed_cost_cents = 0)
      OR (product_id IS NULL AND qty = 0))
);

CREATE INDEX idx_service_costs_service ON service_costs (tenant_id, service_id);

-- Lançamentos financeiros ---------------------------------------------------------

CREATE TABLE revenues (
  id                          INTEGER PRIMARY KEY,
  tenant_id                   INTEGER NOT NULL REFERENCES tenants (id),
  date                        TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  service_id                  INTEGER,
  description                 TEXT    NOT NULL DEFAULT '' CHECK (length(description) <= 120),
  amount_cents                INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 10000000000),
  payment_method              TEXT    NOT NULL CHECK (payment_method IN ('PIX', 'DINHEIRO', 'DEBITO', 'CREDITO', 'OUTRO')),
  notes                       TEXT    NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
  service_cost_snapshot_cents INTEGER NOT NULL DEFAULT 0 CHECK (service_cost_snapshot_cents >= 0),
  user_id                     INTEGER NOT NULL,
  status                      TEXT    NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO', 'CANCELADO')),
  cancelled_by                INTEGER,
  cancelled_at                TEXT,
  cancel_reason               TEXT    CHECK (length(cancel_reason) <= 200),
  created_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, service_id) REFERENCES services (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, cancelled_by) REFERENCES users (tenant_id, id)
);

CREATE INDEX idx_revenues_period ON revenues (tenant_id, status, date);
CREATE INDEX idx_revenues_service ON revenues (tenant_id, service_id, date);

CREATE TABLE expenses (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants (id),
  date                TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  category_id         INTEGER NOT NULL,
  description         TEXT    NOT NULL DEFAULT '' CHECK (length(description) <= 120),
  amount_cents        INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 10000000000),
  payment_method      TEXT    NOT NULL CHECK (payment_method IN ('PIX', 'DINHEIRO', 'DEBITO', 'CREDITO', 'OUTRO')),
  type                TEXT    NOT NULL CHECK (type IN ('CUSTO_VARIAVEL', 'DESPESA_FIXA', 'OUTRA')),
  notes               TEXT    NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
  product_movement_id INTEGER,
  user_id             INTEGER NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO', 'CANCELADO')),
  cancelled_by        INTEGER,
  cancelled_at        TEXT,
  cancel_reason       TEXT    CHECK (length(cancel_reason) <= 200),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, product_movement_id) REFERENCES product_movements (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, cancelled_by) REFERENCES users (tenant_id, id)
);

CREATE INDEX idx_expenses_period ON expenses (tenant_id, status, date);
CREATE INDEX idx_expenses_category ON expenses (tenant_id, category_id, date);

-- Configurações e auditoria -------------------------------------------------------

CREATE TABLE settings (
  tenant_id  INTEGER NOT NULL REFERENCES tenants (id),
  key        TEXT    NOT NULL CHECK (length(key) BETWEEN 1 AND 60),
  value      TEXT    NOT NULL CHECK (length(value) <= 500),
  updated_by INTEGER,
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, key),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id)
);

-- Nunca contém senhas, tokens ou hashes. tenant_id nulo = evento da plataforma.
CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER REFERENCES tenants (id),
  actor_type  TEXT    NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM_ADMIN', 'ANONYMOUS')),
  actor_id    INTEGER,
  action      TEXT    NOT NULL,
  entity      TEXT    NOT NULL,
  entity_id   INTEGER,
  details     TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
  ip_hash     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_audit_tenant ON audit_logs (tenant_id, created_at);
CREATE INDEX idx_audit_entity ON audit_logs (entity, entity_id);
