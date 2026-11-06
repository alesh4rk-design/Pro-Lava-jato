-- Agendamento online: o dono envia um link; o cliente escolhe serviço, dia e horário.
CREATE TABLE booking_settings (
  tenant_id     INTEGER PRIMARY KEY REFERENCES tenants (id),
  code          TEXT    NOT NULL UNIQUE CHECK (length(code) = 12),
  enabled       INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  slot_minutes  INTEGER NOT NULL DEFAULT 60 CHECK (slot_minutes BETWEEN 15 AND 240),
  capacity      INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 10),
  lead_minutes  INTEGER NOT NULL DEFAULT 60 CHECK (lead_minutes BETWEEN 0 AND 10080),
  max_days_ahead INTEGER NOT NULL DEFAULT 14 CHECK (max_days_ahead BETWEEN 1 AND 60),
  auto_confirm  INTEGER NOT NULL DEFAULT 0 CHECK (auto_confirm IN (0, 1)),
  hours         TEXT    NOT NULL DEFAULT '{}',
  instructions  TEXT    NOT NULL DEFAULT '' CHECK (length(instructions) <= 300),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE appointments (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants (id),
  service_id    INTEGER NOT NULL,
  customer_name TEXT    NOT NULL CHECK (length(customer_name) BETWEEN 2 AND 80),
  phone         TEXT    NOT NULL CHECK (length(phone) BETWEEN 10 AND 13 AND phone NOT GLOB '*[^0-9]*'),
  plate         TEXT    NOT NULL DEFAULT '' CHECK (length(plate) <= 8),
  vehicle       TEXT    NOT NULL DEFAULT '' CHECK (length(vehicle) <= 60),
  notes         TEXT    NOT NULL DEFAULT '' CHECK (length(notes) <= 200),
  date          TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  time          TEXT    NOT NULL CHECK (time GLOB '[0-9][0-9]:[0-9][0-9]'),
  status        TEXT    NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'CONFIRMADO', 'CONCLUIDO', 'CANCELADO', 'FALTOU')),
  source        TEXT    NOT NULL DEFAULT 'LINK' CHECK (source IN ('LINK', 'MANUAL')),
  public_token  TEXT    NOT NULL UNIQUE,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, service_id) REFERENCES services (tenant_id, id)
);

CREATE INDEX idx_appointments_day ON appointments (tenant_id, date, time);
CREATE INDEX idx_appointments_phone ON appointments (tenant_id, phone, status, date);
