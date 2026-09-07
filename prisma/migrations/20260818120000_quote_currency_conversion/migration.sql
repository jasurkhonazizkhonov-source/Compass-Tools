-- Multi-currency quote sending: the customer-facing exchange rate used to
-- convert USD pricing, and a frozen JSON snapshot of the converted
-- breakdown captured at send time (currency, rate, and every converted
-- price line) so customer-facing surfaces never recompute on the fly.
ALTER TABLE "Quote" ADD COLUMN "exchangeRate" DECIMAL(12,6);
ALTER TABLE "Quote" ADD COLUMN "pricingSnapshot" JSONB;
