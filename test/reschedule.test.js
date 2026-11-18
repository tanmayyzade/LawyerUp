import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, login, newClient, lawyerByEmail, nextSlot, bookAndPay, pool, query } from './helpers.js';

let lawyerId, lawyer;
before(async () => {
  await resetDb();
  lawyerId = await lawyerByEmail('adv.rohan.mehta@lawyerup.dev');
  lawyer = await login('adv.rohan.mehta@lawyerup.dev');
});
after(() => pool.end());

test('client moves a confirmed booking to another open slot: no new payment, other side is told', async () => {
  const c = await newClient('Mover');
  const { booking } = await bookAndPay(c, lawyerId, await nextSlot(lawyerId, 0));
  const target = await nextSlot(lawyerId, 3);
  const res = await c.post(`/api/bookings/${booking.id}/reschedule`).send({ startsAt: target.startsAt });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(new Date(res.body.booking.starts_at).toISOString(), target.startsAt);
  assert.equal(res.body.booking.status, 'confirmed');
  assert.equal(res.body.booking.reschedule_count, 1);
  assert.equal(res.body.booking.payment.status, 'captured');
  const { rows } = await query(`SELECT count(*)::int n FROM payments WHERE booking_id = $1`, [booking.id]);
  assert.equal(rows[0].n, 1);
  const msgs = (await lawyer.get(`/api/bookings/${booking.id}/messages`)).body.messages;
  assert.match(msgs.at(-1).body, /^Rescheduled from .* to .* IST\.$/);
  // The old slot is free again; the new one is taken.
  const other = await newClient('Takes old slot');
  assert.equal((await other.post('/api/bookings').send({ lawyerId, startsAt: booking.starts_at, mode: 'video' })).status, 201);
  assert.equal((await other.post('/api/bookings').send({ lawyerId, startsAt: target.startsAt, mode: 'video' })).status, 409);
});

test('cannot move onto a taken slot or an unpublished time', async () => {
  const a = await newClient('Client A'); const b = await newClient('Client B');
  const { booking: ba } = await bookAndPay(a, lawyerId, await nextSlot(lawyerId, 0));
  const { booking: bb } = await bookAndPay(b, lawyerId, await nextSlot(lawyerId, 0));
  const clash = await a.post(`/api/bookings/${ba.id}/reschedule`).send({ startsAt: bb.starts_at });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, 'slot_taken');
  const offGrid = new Date(new Date(bb.starts_at).getTime() + 7 * 60000).toISOString();
  assert.equal((await a.post(`/api/bookings/${ba.id}/reschedule`).send({ startsAt: offGrid })).status, 400);
  assert.equal((await a.post(`/api/bookings/${ba.id}/reschedule`).send({ startsAt: ba.starts_at })).status, 400);
});

test('client limits: not within the cancellation window, at most 2 moves; lawyer is not limited', async () => {
  const c = await newClient('Limits');
  const { booking } = await bookAndPay(c, lawyerId, await nextSlot(lawyerId, 0));
  for (const skip of [5, 6]) {
    const r = await c.post(`/api/bookings/${booking.id}/reschedule`).send({ startsAt: (await nextSlot(lawyerId, skip)).startsAt });
    assert.equal(r.status, 200);
  }
  const third = await c.post(`/api/bookings/${booking.id}/reschedule`).send({ startsAt: (await nextSlot(lawyerId, 7)).startsAt });
  assert.equal(third.body.error.code, 'reschedule_limit');
  const byLawyer = await lawyer.post(`/api/bookings/${booking.id}/reschedule`).send({ startsAt: (await nextSlot(lawyerId, 7)).startsAt });
  assert.equal(byLawyer.status, 200);
  assert.equal(byLawyer.body.booking.reschedule_count, 3);

  const c2 = await newClient('Too late');
  const { booking: b2 } = await bookAndPay(c2, lawyerId, await nextSlot(lawyerId, 0));
  await query(`UPDATE bookings SET starts_at = now() + interval '2 hours', ends_at = now() + interval '165 minutes' WHERE id = $1`, [b2.id]);
  const late = await c2.post(`/api/bookings/${b2.id}/reschedule`).send({ startsAt: (await nextSlot(lawyerId, 9)).startsAt });
  assert.equal(late.body.error.code, 'reschedule_too_late');
});

test('only the two participants can reschedule, and only confirmed bookings', async () => {
  const c = await newClient('Owner');
  const { booking } = await bookAndPay(c, lawyerId, await nextSlot(lawyerId, 0));
  const target = (await nextSlot(lawyerId, 10)).startsAt;
  assert.equal((await (await newClient('Stranger')).post(`/api/bookings/${booking.id}/reschedule`).send({ startsAt: target })).status, 404);
  assert.equal((await (await login('lawyer@lawyerup.dev')).post(`/api/bookings/${booking.id}/reschedule`).send({ startsAt: target })).status, 404);
  assert.equal((await (await login('admin@lawyerup.dev')).post(`/api/bookings/${booking.id}/reschedule`).send({ startsAt: target })).status, 403);
  const p = await newClient('Pending');
  const created = await p.post('/api/bookings').send({ lawyerId, startsAt: (await nextSlot(lawyerId, 11)).startsAt, mode: 'video' });
  assert.equal((await p.post(`/api/bookings/${created.body.booking.id}/reschedule`).send({ startsAt: target })).body.error.code, 'not_reschedulable');
});

test('calendar invite: valid iCalendar with reminders, updated sequence, participants only', async () => {
  const c = await newClient('Calendar');
  const { booking } = await bookAndPay(c, lawyerId, await nextSlot(lawyerId, 0));
  const r = await c.get(`/api/bookings/${booking.id}/calendar.ics`);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/calendar/);
  const ics = r.text;
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, new RegExp(`UID:${booking.id}@lawyerup`));
  assert.match(ics, /SEQUENCE:0/);
  assert.match(ics, /TRIGGER:-PT24H/); assert.match(ics, /TRIGGER:-PT15M/);
  assert.match(ics, /SUMMARY:LawyerUp: Video call with Adv\. Rohan Mehta/);
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  await c.post(`/api/bookings/${booking.id}/reschedule`).send({ startsAt: (await nextSlot(lawyerId, 12)).startsAt });
  assert.match((await c.get(`/api/bookings/${booking.id}/calendar.ics`)).text, /SEQUENCE:1/);
  assert.match((await lawyer.get(`/api/bookings/${booking.id}/calendar.ics`)).text, /with Calendar/);
  assert.equal((await (await newClient('Nosy')).get(`/api/bookings/${booking.id}/calendar.ics`)).status, 404);
});
