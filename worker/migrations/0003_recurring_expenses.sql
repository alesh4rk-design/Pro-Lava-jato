-- Despesas recorrentes (diárias, semanais e mensais). O sistema lança a despesa sozinho a cada vencimento
-- (Cron diário e ao abrir o app); cada lançamento é uma despesa comum, que pode ser editada ou cancelada.
CREATE TABLE recurring_expenses (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL REFERENCES tenants (id),
  category_id         INTEGER NOT NULL,
  description         TEXT    NOT NULL DEFAULT '' CHECK (length(description) <= 120),
  amount_cents        INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 10000000000),
  payment_method      TEXT    NOT NULL CHECK (payment_method IN ('PIX', 'DINHEIRO', 'DEBITO', 'CREDITO', 'OUTRO')),
  type                TEXT    NOT NULL CHECK (type IN ('CUSTO_VARIAVEL', 'DESPESA_FIXA', 'OUTRA')),
  frequency           TEXT    NOT NULL CHECK (frequency IN ('DIARIA', 'SEMANAL', 'MENSAL')),
  weekday             INTEGER CHECK (weekday BETWEEN 0 AND 6),            -- 0 = domingo ... 6 = sábado (semanal)
  month_day           INTEGER CHECK (month_day BETWEEN 1 AND 31),         -- dia do mês (mensal; 31 vale como "último dia")
  start_date          TEXT    NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  end_date            TEXT    CHECK (end_date IS NULL OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  last_generated_date TEXT,                                               -- até quando já foi lançado
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by          INTEGER NOT NULL,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (frequency <> 'SEMANAL' OR weekday IS NOT NULL),
  CHECK (frequency <> 'MENSAL' OR month_day IS NOT NULL),
  CHECK (end_date IS NULL OR end_date >= start_date),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);

CREATE INDEX idx_recurring_tenant ON recurring_expenses (tenant_id, active);
CREATE INDEX idx_recurring_due ON recurring_expenses (active, last_generated_date);

-- Liga a despesa lançada à recorrência que a gerou (nulo nas despesas manuais).
ALTER TABLE expenses ADD COLUMN recurring_expense_id INTEGER REFERENCES recurring_expenses (id);
CREATE INDEX idx_expenses_recurring ON expenses (recurring_expense_id, date) WHERE recurring_expense_id IS NOT NULL;
