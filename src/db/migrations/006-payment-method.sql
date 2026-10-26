-- How the customer paid through PayPal: their PayPal account or a card typed in the checkout page.
ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'paypal' CHECK (payment_method IN ('paypal', 'card'));
