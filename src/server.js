import { config } from './config.js';
import { createApp } from './app.js';
import { pool, query } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { expireStaleHolds } from './services/availability.js';

await migrate({ log: (m) => console.log(`[db] ${m}`) });
if (config.demoMode) {
  const { seedIfStale } = await import('./db/seed.js');
  await seedIfStale({ log: (m) => console.log(`[demo] ${m}`) });
}

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`\n  LawyerUp running at http://localhost:${config.port}`);
  console.log(`  payments: ${config.payments.provider} · otp: ${config.otp.provider} · kyc: ${config.kyc.provider} · video: ${config.video.provider}\n`);
});

// Release unpaid holds every minute.
const sweeper = setInterval(() => expireStaleHolds({ query }).catch((e) => console.error('[sweeper]', e.message)), 60_000);

// Demo deployments: keep the sample week current (checked hourly).
const demoRefresh = config.demoMode ? setInterval(async () => {
  try { const { seedIfStale } = await import('./db/seed.js'); await seedIfStale({ log: (m) => console.log(`[demo] ${m}`) }); }
  catch (e) { console.error('[demo]', e.message); }
}, 3_600_000) : null;

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { clearInterval(sweeper); if (demoRefresh) clearInterval(demoRefresh); server.close(() => pool.end().then(() => process.exit(0))); });
}
