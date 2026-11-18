import { config } from './config.js';
import { createApp } from './app.js';
import { pool, query } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { expireStaleHolds } from './services/availability.js';

await migrate({ log: (m) => console.log(`[db] ${m}`) });

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`\n  LawyerUp running at http://localhost:${config.port}`);
  console.log(`  payments: ${config.payments.provider} · otp: ${config.otp.provider} · kyc: ${config.kyc.provider} · video: ${config.video.provider}\n`);
});

// Release unpaid holds every minute.
const sweeper = setInterval(() => expireStaleHolds({ query }).catch((e) => console.error('[sweeper]', e.message)), 60_000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { clearInterval(sweeper); server.close(() => pool.end().then(() => process.exit(0))); });
}
