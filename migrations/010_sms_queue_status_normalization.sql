-- Normalize queue rows to the corrected lowercase database contract.
-- This safely updates older uppercase rows, preserving their logical state.
BEGIN;

UPDATE church.sms_queue
   SET status = lower(status)
 WHERE status <> lower(status)
   AND lower(status) IN ('pending', 'processing', 'sent', 'failed', 'cancelled');

COMMIT;
