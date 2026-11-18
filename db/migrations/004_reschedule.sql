-- Rescheduling: how many times a booking has moved (also the iCalendar SEQUENCE number).
ALTER TABLE bookings ADD COLUMN reschedule_count int NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN rescheduled_at timestamptz;
