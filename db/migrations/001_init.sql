-- LawyerUp — Milestone 1 schema
-- Money is stored in paise (integer). Timestamps are timestamptz (UTC); the app works in IST.

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- needed for the booking overlap constraint
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()

-- ---------------------------------------------------------------- enums
CREATE TYPE user_role           AS ENUM ('client', 'lawyer', 'admin');
CREATE TYPE kyc_status          AS ENUM ('not_started', 'pending', 'verified', 'rejected');
CREATE TYPE verification_status AS ENUM ('pending', 'verified', 'rejected');
CREATE TYPE consult_mode        AS ENUM ('video', 'phone', 'in_person');
CREATE TYPE booking_status      AS ENUM ('pending_payment', 'confirmed', 'cancelled', 'completed', 'expired');
CREATE TYPE payment_status      AS ENUM ('created', 'captured', 'failed', 'refunded');

-- ---------------------------------------------------------------- places (built for expansion across India)
CREATE TABLE cities (
  id         serial PRIMARY KEY,
  slug       text UNIQUE NOT NULL,
  name       text NOT NULL,
  state      text NOT NULL,
  lat        double precision NOT NULL,
  lng        double precision NOT NULL,
  is_live    boolean NOT NULL DEFAULT false      -- Mumbai is live for the demo; others are ready to switch on
);

CREATE TABLE localities (
  id       serial PRIMARY KEY,
  city_id  int NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  name     text NOT NULL,
  lat      double precision NOT NULL,
  lng      double precision NOT NULL,
  UNIQUE (city_id, name)
);

-- ---------------------------------------------------------------- users & identity
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role             user_role NOT NULL,
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  email            text NOT NULL,
  phone            text NOT NULL CHECK (phone ~ '^\+91[6-9][0-9]{9}$'),
  password_hash    text NOT NULL,
  phone_verified   boolean NOT NULL DEFAULT false,
  kyc_status       kyc_status NOT NULL DEFAULT 'not_started',
  kyc_provider     text,
  kyc_reference    text,          -- opaque provider token only. Never an Aadhaar number.
  kyc_verified_at  timestamptz,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
CREATE UNIQUE INDEX users_phone_idx ON users (phone);

CREATE TABLE otp_codes (
  id           bigserial PRIMARY KEY,
  phone        text NOT NULL,
  purpose      text NOT NULL DEFAULT 'register',
  code_hash    text NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_phone_idx ON otp_codes (phone, created_at DESC);

-- ---------------------------------------------------------------- lawyers
CREATE TABLE specializations (
  id    serial PRIMARY KEY,
  slug  text UNIQUE NOT NULL,
  name  text NOT NULL
);

CREATE TABLE lawyer_profiles (
  user_id               uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- credentials (Advocates Act, 1961 enrolment)
  bar_council           text NOT NULL,
  enrollment_number     text NOT NULL,
  enrollment_year       int CHECK (enrollment_year BETWEEN 1950 AND 2100),
  verification_status   verification_status NOT NULL DEFAULT 'pending',
  verification_note     text,
  verified_at           timestamptz,
  verified_by           uuid REFERENCES users(id),
  -- public profile
  headline              text,
  bio                   text,
  experience_years      int NOT NULL DEFAULT 0 CHECK (experience_years BETWEEN 0 AND 70),
  languages             text[] NOT NULL DEFAULT '{}',
  photo_url             text,
  -- location
  city_id               int NOT NULL REFERENCES cities(id),
  area                  text,
  office_address        text,
  lat                   double precision NOT NULL,
  lng                   double precision NOT NULL,
  -- pricing & format
  fee_paise             int NOT NULL CHECK (fee_paise BETWEEN 10000 AND 10000000),  -- ₹100 .. ₹1,00,000
  session_minutes       int NOT NULL DEFAULT 30 CHECK (session_minutes IN (15, 20, 30, 45, 60)),
  modes                 consult_mode[] NOT NULL DEFAULT '{video,phone}',
  -- denormalised rating, maintained on review insert
  rating_avg            numeric(3,2) NOT NULL DEFAULT 0,
  rating_count          int NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bar_council, enrollment_number)
);
CREATE INDEX lawyer_profiles_city_idx ON lawyer_profiles (city_id, verification_status);
CREATE INDEX lawyer_profiles_latlng_idx ON lawyer_profiles (lat, lng);

CREATE TABLE lawyer_specializations (
  lawyer_id          uuid REFERENCES lawyer_profiles(user_id) ON DELETE CASCADE,
  specialization_id  int REFERENCES specializations(id) ON DELETE CASCADE,
  PRIMARY KEY (lawyer_id, specialization_id)
);

-- Weekly recurring availability, in IST wall-clock time.
CREATE TABLE availability_rules (
  id          serial PRIMARY KEY,
  lawyer_id   uuid NOT NULL REFERENCES lawyer_profiles(user_id) ON DELETE CASCADE,
  weekday     int NOT NULL CHECK (weekday BETWEEN 0 AND 6),     -- 0 = Sunday
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  CHECK (end_time > start_time)
);
CREATE INDEX availability_rules_lawyer_idx ON availability_rules (lawyer_id, weekday);

-- Days a lawyer is unavailable (court, leave).
CREATE TABLE availability_blocks (
  id         serial PRIMARY KEY,
  lawyer_id  uuid NOT NULL REFERENCES lawyer_profiles(user_id) ON DELETE CASCADE,
  day        date NOT NULL,
  reason     text,
  UNIQUE (lawyer_id, day)
);

-- ---------------------------------------------------------------- bookings
CREATE TABLE bookings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES users(id),
  lawyer_id           uuid NOT NULL REFERENCES lawyer_profiles(user_id),
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  mode                consult_mode NOT NULL,
  status              booking_status NOT NULL DEFAULT 'pending_payment',
  fee_paise           int NOT NULL,
  platform_fee_paise  int NOT NULL,
  total_paise         int NOT NULL,
  issue_summary       text CHECK (length(issue_summary) <= 500),  -- short, non-confidential topic only
  meeting_url         text,
  hold_expires_at     timestamptz,
  cancelled_by        uuid REFERENCES users(id),
  cancel_reason       text,
  cancelled_at        timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (client_id <> lawyer_id),
  -- The core guarantee: a lawyer can never hold two live bookings that overlap in time.
  CONSTRAINT bookings_no_lawyer_overlap EXCLUDE USING gist (
    lawyer_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('pending_payment', 'confirmed')),
  -- ...and a client can't be in two consultations at once.
  CONSTRAINT bookings_no_client_overlap EXCLUDE USING gist (
    client_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('pending_payment', 'confirmed'))
);
CREATE INDEX bookings_client_idx ON bookings (client_id, starts_at DESC);
CREATE INDEX bookings_lawyer_idx ON bookings (lawyer_id, starts_at DESC);

-- ---------------------------------------------------------------- payments
CREATE TABLE payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id            uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  provider              text NOT NULL,                  -- 'mock' | 'razorpay'
  provider_order_id     text NOT NULL,
  provider_payment_id   text,
  provider_refund_id    text,
  amount_paise          int NOT NULL CHECK (amount_paise > 0),
  refunded_paise        int NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),
  currency              text NOT NULL DEFAULT 'INR',
  status                payment_status NOT NULL DEFAULT 'created',
  failure_reason        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_order_id)
);
CREATE INDEX payments_booking_idx ON payments (booking_id);

-- Every webhook we accept, once (idempotency).
CREATE TABLE payment_events (
  id           bigserial PRIMARY KEY,
  provider     text NOT NULL,
  event_id     text NOT NULL,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- ---------------------------------------------------------------- messages & reviews
CREATE TABLE messages (
  id          bigserial PRIMARY KEY,
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  sender_id   uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_booking_idx ON messages (booking_id, id);

CREATE TABLE reviews (
  id          bigserial PRIMARY KEY,
  booking_id  uuid UNIQUE NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  client_id   uuid NOT NULL REFERENCES users(id),
  lawyer_id   uuid NOT NULL REFERENCES lawyer_profiles(user_id),
  rating      int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     text CHECK (length(comment) <= 1000),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- audit
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  meta        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);
