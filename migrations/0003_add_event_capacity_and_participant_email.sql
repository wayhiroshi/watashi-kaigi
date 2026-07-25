ALTER TABLE registrations ADD COLUMN event_id TEXT;
ALTER TABLE registrations ADD COLUMN participant_email_sent_at TEXT;
ALTER TABLE registrations ADD COLUMN participant_email_message_id TEXT;
ALTER TABLE registrations ADD COLUMN participant_email_last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_registrations_event_id
  ON registrations(event_id);

CREATE TABLE IF NOT EXISTS event_seats (
  event_id TEXT NOT NULL,
  seat_number INTEGER NOT NULL,
  order_id TEXT NOT NULL UNIQUE,
  checkout_session_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('held', 'paid')),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, seat_number)
);

CREATE INDEX IF NOT EXISTS idx_event_seats_status
  ON event_seats(event_id, status, expires_at);
