-- Clientes do lava-jato e mensagens prontas para WhatsApp.
-- O app só monta o link do WhatsApp (wa.me); nenhuma mensagem passa pelo servidor.
CREATE TABLE customers (
  id              INTEGER PRIMARY KEY,
  tenant_id       INTEGER NOT NULL REFERENCES tenants (id),
  name            TEXT    NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  phone           TEXT    NOT NULL CHECK (length(phone) BETWEEN 10 AND 13 AND phone NOT GLOB '*[^0-9]*'),
  vehicle         TEXT    NOT NULL DEFAULT '' CHECK (length(vehicle) <= 60),
  plate           TEXT    NOT NULL DEFAULT '' CHECK (length(plate) <= 8),
  notes           TEXT    NOT NULL DEFAULT '' CHECK (length(notes) <= 300),
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_contact_at TEXT,
  created_by      INTEGER NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);

CREATE INDEX idx_customers_tenant ON customers (tenant_id, active, name COLLATE NOCASE);

CREATE TABLE message_templates (
  id         INTEGER PRIMARY KEY,
  tenant_id  INTEGER NOT NULL REFERENCES tenants (id),
  title      TEXT    NOT NULL CHECK (length(title) BETWEEN 2 AND 60),
  body       TEXT    NOT NULL CHECK (length(body) BETWEEN 2 AND 500),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_templates_tenant ON message_templates (tenant_id, active);
