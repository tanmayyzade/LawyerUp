import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, resetDb, login, newClient, lawyerByEmail, nextSlot, bookAndPay, pool, query } from './helpers.js';

let lawyerId, otherLawyerId;
before(async () => {
  await resetDb();
  lawyerId = await lawyerByEmail('lawyer@lawyerup.dev');
  otherLawyerId = await lawyerByEmail('adv.rohan.mehta@lawyerup.dev');
});
after(() => pool.end());

test('concurrent requests for the same slot: exactly one wins', async () => {
  const slot = await nextSlot(lawyerId);
  const clients = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => newClient(`Racer ${i}`)));
  const results = await Promise.all(clients.map((c) =>
    c.post('/api/bookings').send({ lawyerId, startsAt: slot.startsAt, mode: 'video' })));
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 409, 409, 409, 409, 409]);
  assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'slot_taken'));
  const { rows } = await query(`SELECT count(*)::int n FROM bookings WHERE lawyer_id = $1 AND starts_at = $2 AND status IN ('pending_payment','confirmed')`, [lawyerId, slot.startsAt]);
  assert.equal(rows[0].n, 1);

  // The taken slot shows as unavailable
  const day = await request(app).get(`/api/lawyers/${lawyerId}/slots?date=${new Date(new Date(slot.startsAt).getTime() + 330 * 60000).toISOString().slice(0, 10)}`);
  assert.equal(day.body.slots.find((s) => s.startsAt === slot.startsAt).available, false);
});

test('database constraint blocks overlaps even if the app is bypassed', async () => {
  const slot = await nextSlot(lawyerId, 3);
  const a = await newClient('Direct A');
  await bookAndPay(a, lawyerId, slot);
  const { rows: [c] } = await query(`SELECT id FROM users WHERE email = 'client@lawyerup.dev'`);
  await assert.rejects(
    query(`INSERT INTO bookings (client_id, lawyer_id, starts_at, ends_at, mode, status, fee_paise, platform_fee_paise, total_paise)
           VALUES ($1, $2, $3::timestamptz + interval '10 minutes', $3::timestamptz + interval '40 minutes', 'video', 'confirmed', 1, 0, 1)`,
      [c.id, lawyerId, slot.startsAt]),
    (err) => err.code === '23P01');
});

test('a client cannot hold two consultations at the same time', async () => {
  const slot = await nextSlot(otherLawyerId);
  const c = await newClient('Double Booker');
  // Find an overlapping slot with the other lawyer
  await bookAndPay(c, otherLawyerId, slot);
  const thirdLawyer = await lawyerByEmail('adv.meera.kulkarni@lawyerup.dev');   // same weekday hours as Rohan Mehta
  const overlapping = (await request(app).get(`/api/lawyers/${thirdLawyer}/slots?date=${new Date(new Date(slot.startsAt).getTime() + 330 * 60000).toISOString().slice(0, 10)}`))
    .body.slots.find((s) => s.available && s.startsAt < slot.endsAt && s.endsAt > slot.startsAt);
  assert.ok(overlapping, 'expected an overlapping slot with the second lawyer');
  const res = await c.post('/api/bookings').send({ lawyerId: thirdLawyer, startsAt: overlapping.startsAt, mode: 'video' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'client_overlap');
});

test('only published, future slots in a supported mode can be booked', async () => {
  const c = await newClient('Picky');
  const slot = await nextSlot(lawyerId, 5);
  const offGrid = new Date(new Date(slot.startsAt).getTime() + 7 * 60_000).toISOString();
  assert.equal((await c.post('/api/bookings').send({ lawyerId, startsAt: offGrid, mode: 'video' })).status, 400);
  const past = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal((await c.post('/api/bookings').send({ lawyerId, startsAt: past, mode: 'video' })).status, 400);
  // Rohan Mehta offers video + in_person only
  const s2 = await nextSlot(otherLawyerId, 4);
  const phone = await c.post('/api/bookings').send({ lawyerId: otherLawyerId, startsAt: s2.startsAt, mode: 'phone' });
  assert.equal(phone.status, 400);
  // Pending (unverified) lawyers can't be booked
  const pending = await lawyerByEmail('pending.lawyer@lawyerup.dev');
  assert.equal((await c.post('/api/bookings').send({ lawyerId: pending, startsAt: slot.startsAt, mode: 'video' })).status, 404);
});

test('an expired payment hold frees the slot for someone else', async () => {
  const slot = await nextSlot(lawyerId, 7);
  const a = await newClient('Slow Payer');
  const b = await newClient('Next In Line');
  const first = await a.post('/api/bookings').send({ lawyerId, startsAt: slot.startsAt, mode: 'video' });
  assert.equal(first.status, 201);
  assert.equal((await b.post('/api/bookings').send({ lawyerId, startsAt: slot.startsAt, mode: 'video' })).status, 409);
  await query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [first.body.booking.id]);
  const second = await b.post('/api/bookings').send({ lawyerId, startsAt: slot.startsAt, mode: 'video' });
  assert.equal(second.status, 201);
  assert.equal((await a.get(`/api/bookings/${first.body.booking.id}`)).body.booking.status, 'expired');
});

test('cancellation: refunds follow the policy and free the slot', async () => {
  const slot = await nextSlot(lawyerId, 9);
  const c = await newClient('Canceller');
  const { booking } = await bookAndPay(c, lawyerId, slot);
  assert.equal(booking.status, 'confirmed');

  // Early client cancellation → full refund
  const res = await c.post(`/api/bookings/${booking.id}/cancel`).send({ reason: 'Resolved' });
  assert.equal(res.status, 200);
  assert.equal(res.body.booking.status, 'cancelled');
  assert.deepEqual(res.body.refund, { amount_paise: booking.total_paise, full: true });
  assert.equal(res.body.booking.payment.status, 'refunded');
  assert.equal(res.body.booking.meeting_url, null);

  // Can't cancel twice; the slot is free again
  assert.equal((await c.post(`/api/bookings/${booking.id}/cancel`).send({})).status, 409);
  const again = await (await newClient('Rebooker')).post('/api/bookings').send({ lawyerId, startsAt: slot.startsAt, mode: 'video' });
  assert.equal(again.status, 201);
});

test('late client cancellation refunds 50%; lawyer cancellation always refunds in full', async () => {
  const c = await newClient('Late');
  const { booking } = await bookAndPay(c, lawyerId, await nextSlot(lawyerId, 11));
  await query(`UPDATE bookings SET starts_at = now() + interval '2 hours', ends_at = now() + interval '150 minutes' WHERE id = $1`, [booking.id]);
  const late = await c.post(`/api/bookings/${booking.id}/cancel`).send({});
  assert.equal(late.body.refund.amount_paise, Math.round(booking.total_paise / 2));
  assert.equal(late.body.refund.full, false);

  const c2 = await newClient('Lawyer cancels on me');
  const { booking: b2 } = await bookAndPay(c2, lawyerId, await nextSlot(lawyerId, 12));
  await query(`UPDATE bookings SET starts_at = now() + interval '2 hours', ends_at = now() + interval '150 minutes' WHERE id = $1`, [b2.id]);
  const lawyer = await login('lawyer@lawyerup.dev');
  const res = await lawyer.post(`/api/bookings/${b2.id}/cancel`).send({ reason: 'Court hearing' });
  assert.equal(res.body.refund.amount_paise, b2.total_paise);
});

test('started consultations cannot be cancelled; only the lawyer can complete; reviews once', async () => {
  const c = await newClient('Reviewer');
  const { booking } = await bookAndPay(c, lawyerId, await nextSlot(lawyerId, 14));
  const lawyer = await login('lawyer@lawyerup.dev');

  assert.equal((await lawyer.post(`/api/bookings/${booking.id}/complete`).send({})).status, 409);   // not started yet
  assert.equal((await c.post(`/api/bookings/${booking.id}/review`).send({ rating: 5 })).status, 409); // not completed

  await query(`UPDATE bookings SET starts_at = now() - interval '40 minutes', ends_at = now() - interval '10 minutes' WHERE id = $1`, [booking.id]);
  assert.equal((await c.post(`/api/bookings/${booking.id}/cancel`).send({})).status, 409);
  assert.equal((await c.post(`/api/bookings/${booking.id}/complete`).send({})).status, 403);
  const other = await login('adv.rohan.mehta@lawyerup.dev');
  assert.equal((await other.post(`/api/bookings/${booking.id}/complete`).send({})).status, 404);
  const done = await lawyer.post(`/api/bookings/${booking.id}/complete`).send({});
  assert.equal(done.body.booking.status, 'completed');

  const before = (await request(app).get(`/api/lawyers/${lawyerId}`)).body.lawyer.rating_count;
  assert.equal((await c.post(`/api/bookings/${booking.id}/review`).send({ rating: 5, comment: 'Great' })).status, 201);
  assert.equal((await c.post(`/api/bookings/${booking.id}/review`).send({ rating: 1 })).status, 409);
  const afterCount = (await request(app).get(`/api/lawyers/${lawyerId}`)).body.lawyer.rating_count;
  assert.equal(afterCount, before + 1);
});
