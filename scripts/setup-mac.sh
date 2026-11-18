#!/usr/bin/env bash
# LawyerUp — one-time local setup for macOS.
# Installs/starts PostgreSQL (Homebrew, or Docker if you prefer), creates the databases,
# writes .env, installs packages, migrates, seeds Mumbai demo data and runs the test suite.
set -euo pipefail
cd "$(dirname "$0")/.."

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
die() { printf "\n\033[31m%s\033[0m\n" "$1"; exit 1; }

bold "1/6  Checking Node.js"
command -v node >/dev/null || die "Node.js is not installed. Install Node 20+ from https://nodejs.org or: brew install node"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR found — LawyerUp needs Node 20 or newer (brew upgrade node)."
echo "Node $(node -v) ✓"

bold "2/6  PostgreSQL"
# Note: a `psql` on PATH (e.g. from Anaconda) is only a client — what matters is a running server.
USE_DOCKER="${USE_DOCKER:-}"
PSQL="psql"
server_up() { (command -v pg_isready >/dev/null && pg_isready -q -h localhost -p 5432) || nc -z localhost 5432 >/dev/null 2>&1; }

if [ -z "$USE_DOCKER" ] && ! server_up; then
  if command -v brew >/dev/null; then
    echo "No PostgreSQL server running — installing/starting PostgreSQL 16 with Homebrew…"
    brew list postgresql@16 >/dev/null 2>&1 || brew install postgresql@16
    brew services start postgresql@16
  elif command -v docker >/dev/null; then
    USE_DOCKER=1
  else
    die "No PostgreSQL server found and no Homebrew/Docker. Install Homebrew (https://brew.sh) and re-run, or install Postgres.app (https://postgresapp.com), start it, and re-run."
  fi
fi

if [ -n "$USE_DOCKER" ]; then
  echo "Starting PostgreSQL in Docker…"
  docker compose up -d db
  until docker compose exec -T db pg_isready -U lawyerup >/dev/null 2>&1; do sleep 1; done
else
  # Prefer Homebrew's / Postgres.app's own client over any other psql on PATH (e.g. conda's).
  if command -v brew >/dev/null && [ -x "$(brew --prefix postgresql@16 2>/dev/null)/bin/psql" ]; then
    PSQL="$(brew --prefix postgresql@16)/bin/psql"
  elif [ -x "/Applications/Postgres.app/Contents/Versions/latest/bin/psql" ]; then
    PSQL="/Applications/Postgres.app/Contents/Versions/latest/bin/psql"
  fi
  for i in $(seq 1 30); do server_up && break; sleep 1; done
  server_up || die "PostgreSQL isn't accepting connections on localhost:5432. Try: brew services restart postgresql@16 — then re-run."
  echo "Creating role and databases (safe to re-run)…"
  "$PSQL" -h localhost -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lawyerup') THEN
    CREATE ROLE lawyerup LOGIN PASSWORD 'lawyerup' CREATEDB;
  END IF;
END $$;
SQL
  for db in lawyerup lawyerup_test; do
    "$PSQL" -h localhost -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
      || "$PSQL" -h localhost -d postgres -q -c "CREATE DATABASE $db OWNER lawyerup"
  done
fi
echo "PostgreSQL ready ✓"

bold "3/6  Environment"
if [ ! -f .env ]; then
  cp .env.example .env
  SECRET=$(openssl rand -hex 32)
  sed -i '' "s/^JWT_SECRET=.*/JWT_SECRET=$SECRET/" .env
  echo "Wrote .env with a fresh JWT secret ✓"
else
  echo ".env already exists — leaving it alone ✓"
fi

bold "4/6  Installing packages"
npm install --no-fund --no-audit

bold "5/6  Database schema + Mumbai demo data"
npm run db:reset

bold "6/6  Running the test suite"
npm test

bold "All set."
echo "Start the app:   npm run dev"
echo "Then open:       http://localhost:4173"
echo "Demo logins (password Demo@1234): client@lawyerup.dev · lawyer@lawyerup.dev · admin@lawyerup.dev"
