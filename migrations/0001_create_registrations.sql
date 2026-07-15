CREATE TABLE IF NOT EXISTS stripe_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  checkout_session_id TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL UNIQUE,
  checkout_session_id TEXT NOT NULL UNIQUE,
  payment_intent_id TEXT,
  latest_stripe_event_id TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  amount_total INTEGER,
  currency TEXT,
  participant_name TEXT NOT NULL,
  participant_email TEXT NOT NULL,
  participant_tel TEXT,
  event_date TEXT,
  ai_experience TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_registrations_email
  ON registrations(participant_email);

CREATE INDEX IF NOT EXISTS idx_registrations_event_date
  ON registrations(event_date);

CREATE INDEX IF NOT EXISTS idx_registrations_payment_status
  ON registrations(payment_status);
