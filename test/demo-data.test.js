import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, newClient, lawyerByEmail, nextSlot, bookAndPay, pool, query } from './helpers.js';
import { seedIfStale } from '../src/db/seed.js';
import { migrate } from '../src/db/migrate.js';

before(resetDb);
after(() => pool.end());

test('demo refresh never deletes real accounts or bookings', async () => {
  const real = await newClient('Real Person');
  const lawyerId = await lawyerByEmail('adv.rohan.mehta@lawyerup.dev');
  const { booking } = await bookAndPay(real, lawyerId, await nextSlot(lawyerId));
  const before = (await query('SELECT count(*)::int n FROM users')).rows[0].n;

  // Remove the demo lawyer's future bookings so a top-up is needed
  await query(`UPDATE bookings SET status = 'cancelled' WHERE lawyer_id = (SELECT id FROM users WHERE email = 'lawyer@lawyerup.dev') AND starts_at > now()`);
  const result = await seedIfStale({ log: () => {} });
  assert.equal(result, 'topped_up');

  assert.equal((await query('SELECT count(*)::int n FROM users')).rows[0].n, before);
  const { rows: [b] } = await query('SELECT status FROM bookings WHERE id = $1', [booking.id]);
  assert.equal(b.status, 'confirmed');
  const { rows: [u] } = await query('SELECT count(*)::int n FROM users WHERE id = $1', [real.user.id]);
  assert.equal(u.n, 1);
  // Running again with a full diary changes nothing
  assert.equal(await seedIfStale({ log: () => {} }), 'ok');
});

test('an empty database gets the full demo data', async () => {
  await migrate({ reset: true, log: () => {} });
  assert.equal(await seedIfStale({ log: () => {} }), 'seeded');
  assert.ok((await query(`SELECT count(*)::int n FROM lawyer_profiles WHERE verification_status = 'verified'`)).rows[0].n >= 20);
});
