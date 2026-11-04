-- Promotions «1+1» and «2+1» (the gift is the same product as the order).
--   promo      '' (none) | '1+1' | '2+1'
--   paid_qty   units the client paid for
--   gift_qty   units sent as a gift (1+1: = paid, 2+1: floor(paid / 2))
-- orders.qty stays the TOTAL shipped quantity (paid + gift): the stock deduction and every report keep reading it.
-- orders.sum stays the money received.
ALTER TABLE orders ADD COLUMN promo TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN paid_qty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN gift_qty INTEGER NOT NULL DEFAULT 0;
UPDATE orders SET paid_qty = qty, gift_qty = 0;
