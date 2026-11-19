-- Sign in with Google: accounts may have no password, and may add their mobile number after signing up.
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;           -- CHECK still validates any number that is set
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;   -- Google-only accounts
ALTER TABLE users ADD COLUMN google_sub text;                 -- Google's stable account id
ALTER TABLE users ADD COLUMN avatar_url text;
ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX users_google_sub_idx ON users (google_sub) WHERE google_sub IS NOT NULL;
