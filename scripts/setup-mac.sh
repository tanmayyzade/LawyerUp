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
USE_DOCKER="${USE_DOCKER:-}"
if [ -z "$USE_DOCKER" ] && ! command -v psql >/dev/null; then
  if command -v brew >/dev/null; then
    echo "Installing PostgreSQL 16 with Homebrew…"
    brew install postgresql@16
    brew link --force postgresql@16 >/dev/null 2>&1 || true
    export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
  elif command -v docker >/dev/null; then
    USE_DOCKER=1
  else
    die "No PostgreSQL found. Install one of: Homebrew (https://brew.sh) then re-run, Postgres.app (https://postgresapp.com), or Docker Desktop."
  fi
fi

if [ -n "$USE_DOCKER" ]; then
  echo "Starting PostgreSQL in Docker…"
  docker compose up -d db
  until docker compose exec -T db pg_isready -U lawyerup >/dev/null 2>&1; do sleep 1; done
else
  if command -v brew >/dev/null && brew list postgresql@16 >/dev/null 2>&1; then
    brew services start postgresql@16 >/dev/null || true
  fi
  for i in $(seq 1 20); do pg_isready -q -h localhost && break; sleep 1; done
  pg_isready -q -h localhost || die "PostgreSQL isn't accepting connections on localhost:5432. Start it (brew services start postgresql@16, or open Postgres.app) and re-run."
  echo "Creating role and databases (safe to re-run)…"
  psql -h localhost -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lawyerup') THEN
    CREATE ROLE lawyerup LOGIN PASSWORD 'lawyerup' CREATEDB;
  END IF;
END $$;
SQL
  for db in lawyerup lawyerup_test; do
    psql -h localhost -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
      || psql -h localhost -d postgres -q -c "CREATE DATABASE $db OWNER lawyerup"
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
