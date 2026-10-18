-- Receita ligada ao cliente que fez a limpeza (opcional). O lava-jato do cliente é conferido no código, em toda gravação.
ALTER TABLE revenues ADD COLUMN customer_id INTEGER REFERENCES customers (id);
CREATE INDEX idx_revenues_customer ON revenues (tenant_id, customer_id, date) WHERE customer_id IS NOT NULL;
