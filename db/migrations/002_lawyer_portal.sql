-- Lawyer portal: private notes, message read tracking, earnings view.

-- Private to the lawyer of the booking; never returned to the client.
ALTER TABLE bookings ADD COLUMN lawyer_notes text CHECK (length(lawyer_notes) <= 5000);

-- Last message each participant has seen, per booking (for unread counts).
CREATE TABLE message_reads (
  booking_id    uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id  bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, user_id)
);

-- What the lawyer earns from each booking:
--   completed                     → the full consultation fee
--   cancelled with partial refund → the lawyer's share of what the client wasn't refunded
--   anything else                 → 0
CREATE VIEW lawyer_earnings AS
SELECT b.id AS booking_id, b.lawyer_id, b.client_id, b.starts_at, b.status, b.fee_paise, b.total_paise,
       CASE
         WHEN b.status = 'completed' THEN b.fee_paise
         WHEN b.status = 'cancelled' AND p.status = 'refunded' AND p.refunded_paise < p.amount_paise
           THEN round((p.amount_paise - p.refunded_paise)::numeric * b.fee_paise / b.total_paise)::int
         ELSE 0
       END AS earned_paise
  FROM bookings b
  LEFT JOIN LATERAL (
    SELECT status, amount_paise, refunded_paise FROM payments
     WHERE booking_id = b.id AND status IN ('captured', 'refunded')
     ORDER BY created_at DESC LIMIT 1) p ON true;
