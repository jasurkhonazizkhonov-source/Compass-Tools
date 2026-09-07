-- Part 17: the internal "booking confirmed / profit" notification email
-- gets its own EmailLog.type value, distinct from BOOKING_NOTIFICATION
-- (the "booking form signed" internal notification) and BOOKING_CONFIRMATION
-- (the customer-facing confirmation) — three different audiences/purposes.
ALTER TYPE "EmailType" ADD VALUE 'BOOKING_PROFIT_NOTIFICATION';
