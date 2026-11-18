# LawyerUp

Find a lawyer nearby, compare consultation fees, and book a video, phone or in-person consultation.
**Milestone 1** is a full-stack core with a real PostgreSQL backend. Mumbai is the live demo city, and the data model is ready for other Indian cities.

> This is a development build. Payments, OTP and identity checks use simulated providers by default. Don't enter real Aadhaar numbers or confidential case documents.

## Quick start (macOS)

```bash
cd ~/Documents/LawyerUp
./scripts/setup-mac.sh      # one-time: Postgres, .env, packages, schema, demo data, tests
npm run dev                 # http://localhost:4173
```

The setup script installs PostgreSQL 16 with Homebrew if `psql` isn't found. If there's no Homebrew, it uses Docker. To force Docker, run `USE_DOCKER=1 ./scripts/setup-mac.sh`.

**Demo logins** (password `Demo@1234`):

| Role | Email |
|---|---|
| Client | client@lawyerup.dev |
| Lawyer | lawyer@lawyerup.dev (Adv. Aditi Deshmukh, Fort) |
| Admin | admin@lawyerup.dev |

In development, the sign-up OTP is shown on screen and printed in the server log, because no SMS is sent.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-reload. Migrations run on start. |
| `npm start` | Start without auto-reload. |
| `npm test` | Run the 34 API tests against `TEST_DATABASE_URL`. The test database is wiped on every run. |
| `npm run db:migrate` | Apply new SQL migrations from `db/migrations/`. |
| `npm run db:reset` | Drop everything, re-migrate and re-seed the demo data. |

## What's in Milestone 1

| Requirement | Where |
|---|---|
| PostgreSQL for users, lawyer credentials, availability, bookings, payments, messages | `db/migrations/001_init.sql` |
| Server-side auth & authorisation (client / lawyer / admin) | `src/lib/auth.js`: scrypt passwords, JWT in an httpOnly SameSite cookie, role guards. Bookings are scoped per row. |
| Location search with real radius results | `GET /api/lawyers`: bounding box, then great-circle (Haversine) distance in SQL, sorted and filtered |
| Bookings that can't overlap | Postgres `EXCLUDE USING gist` constraints for each lawyer and each client. Unpaid holds expire after 10 minutes. |
| Providers swapped through environment variables | `src/providers/`: payments (mock / Razorpay), OTP (console / MSG91), KYC (sandbox), video (Jitsi) |
| Automated tests | `test/`: booking conflicts (including concurrent requests), cancellation and refunds, authorisation, every payment state, search |

**User flows**

- **Client:** search by area or "Near me" → filter → compare up to 3 lawyers → pick a slot → pay (with retry) → confirmation and meeting link → chat → cancel or review.
- **Lawyer:** register (stays hidden until verified) → workspace with stats, weekly hours, days off and profile editing → mark consultations complete.
- **Admin:** queue to verify or reject Bar Council enrolments. Every decision goes to the audit log.

### Booking & payment lifecycle

```
pending_payment ──(payment captured)──▶ confirmed ──(lawyer marks done)──▶ completed
      │  └─(hold expires)──▶ expired ──(late payment, slot still free)──▶ confirmed
      │                         └────(late payment, slot taken)──▶ auto full refund
      └─(cancel)──▶ cancelled                    confirmed ──(cancel)──▶ cancelled + refund
```

**Refund policy:** if the client cancels at least `FREE_CANCEL_HOURS` (4) hours before the start, they get 100% back. Later than that, they get 50%. If the lawyer cancels, the client always gets 100%.
**Fees:** lawyer fee + `PLATFORM_FEE_BPS` (10%) service fee, charged as one order. All amounts are stored in paise.

## Going live with real providers

1. **Razorpay:** set `PAYMENT_PROVIDER=razorpay` and add your keys to `.env`. In the Razorpay dashboard, add a webhook pointing to `https://<your-domain>/api/payments/webhook/razorpay` for the events `payment.captured`, `payment.failed` and `order.paid`. Use the same webhook secret in both places.
2. **OTP:** set `OTP_PROVIDER=msg91` with an approved DLT template.
3. **Identity (KYC):** integrate a UIDAI-licensed AUA/KUA partner or DigiLocker in `src/providers/kyc.js`. Store only the partner's reference token. Any Aadhaar data must live in an Aadhaar Data Vault and never in this database.
4. **Video:** replace the Jitsi rooms with a provider that issues expiring, per-participant tokens (e.g. 100ms, Daily, Twilio).
5. **Production:** set `NODE_ENV=production` and a strong `JWT_SECRET`, run behind HTTPS (cookies become `Secure`), and move the in-memory rate limiter to Redis.

## Live demo (Render)

`render.yaml` is a Render Blueprint: a free Node web service plus a free PostgreSQL database. In the Render dashboard, choose **New → Blueprint** and select this repository. Render builds the app, runs the migrations on start, and loads the Mumbai demo data.

The blueprint sets `DEMO_MODE=true`, which keeps these on in production so visitors can try every flow:

- simulated payments
- the on-screen sign-up code
- sample data that refreshes every 24 hours (`DEMO_RESEED_HOURS`)

Turn `DEMO_MODE` off before using real providers or real data.

Render's free tier has limits:

- The web service sleeps after about 15 minutes without visitors, and the first request after that takes about a minute.
- Free databases expire after 30 days unless you upgrade.

## Adding a city

Set `is_live = true` on a row in `cities`, add its `localities` with their coordinates, and onboard lawyers there. Search, slots and booking don't need any changes. Everything runs on IST.

## Project layout

```
db/migrations/      SQL schema (applied in order, tracked in schema_migrations)
src/
  app.js            Express app, security headers, error handling
  server.js         Entry point: migrate, listen, sweep expired holds every minute
  config.js         All settings from environment variables
  routes/           auth, public (search/profile/slots), bookings (+chat, reviews), payments, workspace (lawyer/admin)
  services/         availability (slot generation), bookings (create/cancel/complete, payment state machine)
  providers/        payments, otp, kyc, video
  db/               pool, migrate, seed
public/             Frontend (no build step): index.html, app.js, styles.css
test/               node:test + supertest
scripts/            setup-mac.sh, docker-init.sql
```
