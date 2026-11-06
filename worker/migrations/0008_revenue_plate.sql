-- Placa do veículo no lançamento de receita (opcional), mesmo para quem não é cliente cadastrado.
ALTER TABLE revenues ADD COLUMN plate TEXT NOT NULL DEFAULT '' CHECK (length(plate) <= 8);
CREATE INDEX idx_revenues_plate ON revenues (tenant_id, plate) WHERE plate <> '';
