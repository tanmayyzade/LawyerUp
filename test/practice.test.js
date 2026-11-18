import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, resetDb, login, newClient, lawyerByEmail, nextSlot, bookAndPay, pool, query } from './helpers.js';

let lawyer, other, client;
before(async () => {
  await resetDb();
  lawyer = await login('lawyer@lawyerup.dev');
  other = await login('adv.rohan.mehta@lawyerup.dev');
  client = await login('client@lawyerup.dev');
});
after(() => pool.end());

test('portal endpoints are for lawyers only', async () => {
  for (const path of ['dashboard', 'appointments', 'clients', 'inbox', 'earnings', 'reviews', 'schedule?from=2026-01-01']) {
    assert.equal((await request(app).get(`/api/lawyer/${path}`)).status, 401, path);
    assert.equal((await client.get(`/api/lawyer/${path}`)).status, 403, path);
    assert.equal((await lawyer.get(`/api/lawyer/${path}`)).status, 200, path);
  }
});

test('dashboard shows today, the next consultation and what needs attention', async () => {
  const { body } = await lawyer.get('/api/lawyer/dashboard');
  assert.ok(body.today.length >= 4);
  assert.ok(body.stats.to_complete >= 1);       // yesterday's consultation not yet marked complete
  assert.ok(body.stats.unread >= 1);
  assert.equal(body.week.length, 7);
  assert.equal(body.profile.verification_status, 'verified');
  if (body.next) assert.equal(body.next.status, 'confirmed');
});

test('appointments are split into views with counts, and only the lawyer\'s own', async () => {
  const views = ['upcoming', 'awaiting_payment', 'to_complete', 'completed', 'cancelled'];
  const { body: first } = await lawyer.get('/api/lawyer/appointments');
  for (const view of views) {
    const { body } = await lawyer.get(`/api/lawyer/appointments?view=${view}`);
    assert.equal(body.appointments.length, first.counts[view], view);
  }
  const mine = new Set((await query(`SELECT id FROM bookings WHERE lawyer_id = $1`, [lawyer.user.id])).rows.map((r) => r.id));
  const { body: o } = await other.get('/api/lawyer/appointments?view=completed');
  assert.ok(o.appointments.every((a) => !mine.has(a.id)));
});

test('earnings include completed fees and the lawyer\'s share of late cancellations', async () => {
  const { body } = await lawyer.get('/api/lawyer/earnings');
  assert.equal(body.months.length, 6);
  const { rows: [x] } = await query(
    `SELECT COALESCE(sum(fee_paise) FILTER (WHERE status = 'completed'),0)::int AS completed FROM bookings WHERE lawyer_id = $1`, [lawyer.user.id]);
  assert.ok(body.totals.from_late_cancellations > 0);
  assert.equal(body.totals.all_time, x.completed + body.totals.from_late_cancellations);
  // Seeded late cancellation: ₹2,750 paid, ₹1,375 refunded → lawyer keeps their share of the rest: ₹1,250.
  assert.equal(body.totals.from_late_cancellations, 125000);
});

test('private notes and client contact are visible only to the booking\'s lawyer', async () => {
  const c = await newClient('Notes client');
  const { booking } = await bookAndPay(c, lawyer.user.id, await nextSlot(lawyer.user.id));
  assert.equal((await lawyer.put(`/api/bookings/${booking.id}/notes`).send({ notes: 'Bring sale deed.' })).status, 200);
  assert.equal((await other.put(`/api/bookings/${booking.id}/notes`).send({ notes: 'x' })).status, 404);
  assert.equal((await c.put(`/api/bookings/${booking.id}/notes`).send({ notes: 'x' })).status, 403);

  const asLawyer = (await lawyer.get(`/api/bookings/${booking.id}`)).body.booking;
  assert.equal(asLawyer.lawyer_notes, 'Bring sale deed.');
  assert.match(asLawyer.client_phone, /^\+91/);
  const asClient = (await c.get(`/api/bookings/${booking.id}`)).body.booking;
  assert.equal(asClient.lawyer_notes, undefined);
  assert.equal(asClient.client_phone, undefined);
  const adminView = (await (await login('admin@lawyerup.dev')).get(`/api/bookings/${booking.id}`)).body.booking;
  assert.equal(adminView.lawyer_notes, undefined);
});

test('client phone is hidden until the booking is paid', async () => {
  const c = await newClient('Unpaid client');
  const created = await c.post('/api/bookings').send({ lawyerId: lawyer.user.id, startsAt: (await nextSlot(lawyer.user.id, 2)).startsAt, mode: 'phone' });
  const b = (await lawyer.get(`/api/bookings/${created.body.booking.id}`)).body.booking;
  assert.equal(b.client_phone, null);
  const awaiting = (await lawyer.get('/api/lawyer/appointments?view=awaiting_payment')).body.appointments;
  assert.ok(awaiting.some((a) => a.id === b.id && a.client_phone === null));
});

test('inbox unread counts clear when the lawyer reads the thread', async () => {
  const { body: before } = await lawyer.get('/api/lawyer/inbox');
  const t = before.threads.find((x) => x.unread > 0);
  assert.ok(t);
  await lawyer.get(`/api/bookings/${t.booking_id}/messages`);
  const { body: afterRead } = await lawyer.get('/api/lawyer/inbox');
  assert.equal(afterRead.threads.find((x) => x.booking_id === t.booking_id).unread, 0);
});

test('clients list and client detail are limited to people who booked this lawyer', async () => {
  const { body } = await lawyer.get('/api/lawyer/clients');
  assert.ok(body.clients.length > 0);
  const someone = body.clients[0];
  assert.equal((await lawyer.get(`/api/lawyer/clients/${someone.id}`)).status, 200);
  const stranger = await newClient('Never booked');
  assert.equal((await lawyer.get(`/api/lawyer/clients/${stranger.user.id}`)).status, 404);
});

test('schedule returns a week of bookings, hours and days off', async () => {
  const from = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const { body } = await lawyer.get(`/api/lawyer/schedule?from=${from}&days=7`);
  assert.ok(body.bookings.length > 0);
  assert.ok(body.rules.length > 0);
  assert.ok(body.bookings.every((b) => ['confirmed', 'completed', 'pending_payment'].includes(b.status)));
});
