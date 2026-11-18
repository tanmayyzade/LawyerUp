-- Small key/value table for app bookkeeping (e.g. when demo data was last loaded).
CREATE TABLE app_meta (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
