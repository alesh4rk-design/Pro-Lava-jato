-- Chave PIX do lava-jato (cadastrada em Configurações) e mensagem pronta "Chave PIX" para os lava-jatos que já existem.
ALTER TABLE tenants ADD COLUMN pix_key TEXT NOT NULL DEFAULT '' CHECK (length(pix_key) <= 77);
ALTER TABLE tenants ADD COLUMN pix_key_type TEXT NOT NULL DEFAULT '' CHECK (pix_key_type IN ('', 'CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'ALEATORIA'));
ALTER TABLE tenants ADD COLUMN pix_holder TEXT NOT NULL DEFAULT '' CHECK (length(pix_holder) <= 60);

-- Lava-jatos que já receberam as mensagens padrão ganham também a da chave PIX (os novos recebem pelo código).
INSERT INTO message_templates (tenant_id, title, body)
SELECT tenant_id, 'Chave PIX',
       'Olá, {nome}! Segue a chave PIX do {lavajato} para pagamento:' || char(10) || char(10) || '{pix}' || char(10) || char(10) || 'Depois de pagar, é só enviar o comprovante por aqui. Obrigado!'
  FROM settings WHERE key = 'templates_seeded';
