import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, resetDb, login, newClient, lawyerByEmail, nextSlot, bookAndPay, pool } from './helpers.js';

let lawyerId, owner, booking;
before(async () => {
  await resetDb();
  lawyerId = await lawyerByEmail('lawyer@lawyerup.dev');
  owner = await newClient('Owner');
  ({ booking } = await bookAndPay(owner, lawyerId, await nextSlot(lawyerId)));
});
after(() => pool.end());

test('bookings are visible only to their client, their lawyer and admins', async () => {
  const stranger = await newClient('Stranger');
  const otherLawyer = await login('adv.rohan.mehta@lawyerup.dev');
  const lawyer = await login('lawyer@lawyerup.dev');
  const admin = await login('admin@lawyerup.dev');

  assert.equal((await request(app).get(`/api/bookings/${booking.id}`)).status, 401);
  assert.equal((await stranger.get(`/api/bookings/${booking.id}`)).status, 404);
  assert.equal((await otherLawyer.get(`/api/bookings/${booking.id}`)).status, 404);
  assert.equal((await owner.get(`/api/bookings/${booking.id}`)).status, 200);
  assert.equal((await lawyer.get(`/api/bookings/${booking.id}`)).status, 200);
  assert.equal((await admin.get(`/api/bookings/${booking.id}`)).status, 200);

  // Lists are scoped to the caller
  assert.ok(!(await stranger.get('/api/bookings')).body.bookings.some((b) => b.id === booking.id));
  assert.ok((await lawyer.get('/api/bookings')).body.bookings.some((b) => b.id === booking.id));
  assert.ok(!(await otherLawyer.get('/api/bookings')).body.bookings.some((b) => b.id === booking.id));

  // Strangers can't cancel, pay for or review someone else's booking
  assert.equal((await stranger.post(`/api/bookings/${booking.id}/cancel`).send({})).status, 404);
  assert.equal((await stranger.post(`/api/bookings/${booking.id}/payment-order`).send({})).status, 404);
  assert.equal((await stranger.post(`/api/bookings/${booking.id}/review`).send({ rating: 1 })).status, 404);
});

test('messages: only the two participants, only after confirmation; admins cannot read', async () => {
  const lawyer = await login('lawyer@lawyerup.dev');
  const stranger = await newClient('Snoop');
  const admin = await login('admin@lawyerup.dev');

  const sent = await owner.post(`/api/bookings/${booking.id}/messages`).send({ body: 'Hello, sharing a short question.' });
  assert.equal(sent.status, 201);
  const reply = await lawyer.post(`/api/bookings/${booking.id}/messages`).send({ body: 'Hi! See you at the call.' });
  assert.equal(reply.status, 201);

  const thread = await owner.get(`/api/bookings/${booking.id}/messages`);
  assert.deepEqual(thread.body.messages.map((m) => m.body), ['Hello, sharing a short question.', 'Hi! See you at the call.']);
  const after = await owner.get(`/api/bookings/${booking.id}/messages?after=${thread.body.messages[0].id}`);
  assert.equal(after.body.messages.length, 1);

  assert.equal((await stranger.get(`/api/bookings/${booking.id}/messages`)).status, 404);
  assert.equal((await stranger.post(`/api/bookings/${booking.id}/messages`).send({ body: 'hi' })).status, 404);
  assert.equal((await admin.get(`/api/bookings/${booking.id}/messages`)).status, 403);

  // Unpaid booking: chat closed
  const c = await newClient('Unpaid');
  const pending = await c.post('/api/bookings').send({ lawyerId, startsAt: (await nextSlot(lawyerId, 2)).startsAt, mode: 'video' });
  assert.equal((await c.post(`/api/bookings/${pending.body.booking.id}/messages`).send({ body: 'hi' })).status, 409);
});

test('meeting link is only revealed once confirmed', async () => {
  const c = await newClient('Linky');
  const created = await c.post('/api/bookings').send({ lawyerId, startsAt: (await nextSlot(lawyerId, 4)).startsAt, mode: 'video' });
  assert.equal(created.body.booking.meeting_url, null);
  const confirmed = (await owner.get(`/api/bookings/${booking.id}`)).body.booking;
  assert.match(confirmed.meeting_url, /^https:\/\/meet\.jit\.si\/LawyerUp-/);
});

test('lawyers can only edit their own workspace', async () => {
  const lawyer = await login('lawyer@lawyerup.dev');
  const res = await lawyer.put('/api/lawyer/availability').send({ rules: [{ weekday: 1, start: '09:00', end: '12:00' }, { weekday: 1, start: '11:00', end: '13:00' }] });
  assert.equal(res.status, 400);   // overlapping windows
  const ok = await lawyer.put('/api/lawyer/availability').send({ rules: [{ weekday: 2, start: '09:00', end: '12:00' }] });
  assert.equal(ok.status, 200);
  const other = await request(app).get(`/api/lawyers/${await lawyerByEmail('adv.rohan.mehta@lawyerup.dev')}`);
  assert.ok(other.body.availability.length > 1);   // untouched
  const mine = await request(app).get(`/api/lawyers/${lawyerId}`);
  assert.deepEqual(mine.body.availability, [{ weekday: 2, start: '09:00', end: '12:00' }]);
});

test('lawyer profile API returns arrays, not Postgres array literals', async () => {
  const lawyer = await login('lawyer@lawyerup.dev');
  const { body } = await lawyer.get('/api/lawyer/profile');
  assert.ok(Array.isArray(body.profile.modes));
  assert.ok(Array.isArray(body.profile.languages));
  assert.ok(Array.isArray(body.profile.specializations));
});
