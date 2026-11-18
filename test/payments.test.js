import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { app, resetDb, newClient, lawyerByEmail, nextSlot, pool, query } from './helpers.js';
import { razorpayProvider } from '../src/providers/payments.js';

let lawyerId;
before(async () => { await resetDb(); lawyerId = await lawyerByEmail('lawyer@lawyerup.dev'); });
after(() => pool.end());

const startBooking = async (c, skip = 0) => {
  const res = await c.post('/api/bookings').send({ lawyerId, startsAt: (await nextSlot(lawyerId, skip)).startsAt, mode: 'video' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
};
const mockPay = async (c, orderId) => (await c.post('/api/payments/mock/checkout').send({ orderId, outcome: 'success' })).body;

test('fee breakdown: lawyer fee + 10% platform fee, charged as one order', async () => {
  const c = await newClient('Payer');
  const { booking, checkout } = await startBooking(c);
  assert.equal(booking.status, 'pending_payment');
  assert.equal(booking.platform_fee_paise, Math.round(booking.fee_paise * 0.1));
  assert.equal(checkout.amount, booking.total_paise);
  assert.equal(booking.payment.status, 'created');
});

test('a forged signature is rejected and the booking stays unpaid', async () => {
  const c = await newClient('Forger');
  const { booking, checkout } = await startBooking(c, 1);
  const res = await c.post('/api/payments/verify').send({ orderId: checkout.orderId, paymentId: 'pay_fake', signature: 'deadbeef' });
  assert.equal(res.status, 400);
  const b = (await c.get(`/api/bookings/${booking.id}`)).body.booking;
  assert.equal(b.status, 'pending_payment');
  assert.equal(b.payment.status, 'created');
});

test('another client cannot verify or fail my payment', async () => {
  const c = await newClient('Mine');
  const thief = await newClient('Thief');
  const { checkout } = await startBooking(c, 2);
  const paid = await mockPay(c, checkout.orderId);
  assert.equal((await thief.post('/api/payments/verify').send({ orderId: paid.orderId, paymentId: paid.paymentId, signature: paid.signature })).status, 404);
  assert.equal((await thief.post('/api/payments/failed').send({ orderId: checkout.orderId })).status, 404);
  assert.equal((await thief.post('/api/payments/mock/checkout').send({ orderId: checkout.orderId, outcome: 'success' })).status, 404);
});

test('failed payment → retry with a new order → success confirms; verifying twice is idempotent', async () => {
  const c = await newClient('Retrier');
  const { booking, checkout } = await startBooking(c, 3);

  const failed = await c.post('/api/payments/failed').send({ orderId: checkout.orderId, reason: 'Card declined' });
  assert.equal(failed.body.outcome, 'failed');
  assert.equal(failed.body.booking.status, 'pending_payment');   // hold continues
  assert.equal(failed.body.booking.payment.status, 'failed');

  const retry = await c.post(`/api/bookings/${booking.id}/payment-order`).send({});
  assert.equal(retry.status, 200);
  assert.notEqual(retry.body.checkout.orderId, checkout.orderId);

  const paid = await mockPay(c, retry.body.checkout.orderId);
  const ok = await c.post('/api/payments/verify').send(paid);
  assert.equal(ok.body.outcome, 'confirmed');
  assert.equal(ok.body.booking.status, 'confirmed');
  assert.equal(ok.body.booking.payment.status, 'captured');

  const again = await c.post('/api/payments/verify').send(paid);
  assert.equal(again.body.outcome, 'already');
  const { rows } = await query(`SELECT status FROM payments WHERE booking_id = $1 ORDER BY created_at`, [booking.id]);
  assert.deepEqual(rows.map((r) => r.status), ['failed', 'captured']);

  // Can't open a new order for a confirmed booking
  assert.equal((await c.post(`/api/bookings/${booking.id}/payment-order`).send({})).status, 409);
});

test('payment arriving after the hold expired: confirmed if the slot is still free', async () => {
  const c = await newClient('Late but lucky');
  const { booking, checkout } = await startBooking(c, 4);
  await query(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [booking.id]);
  await c.get('/api/bookings');   // triggers the sweeper
  const paid = await mockPay(c, checkout.orderId);
  const res = await c.post('/api/payments/verify').send(paid);
  assert.equal(res.body.outcome, 'confirmed');
  assert.equal(res.body.booking.status, 'confirmed');
});

test('payment arriving after the hold expired and the slot was taken: automatic full refund', async () => {
  const slot = await nextSlot(lawyerId, 5);
  const a = await newClient('Too late');
  const b = await newClient('Got it');
  const first = await a.post('/api/bookings').send({ lawyerId, startsAt: slot.startsAt, mode: 'video' });
  await query(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [first.body.booking.id]);
  const second = await b.post('/api/bookings').send({ lawyerId, startsAt: slot.startsAt, mode: 'video' });
  assert.equal(second.status, 201);

  const paid = await mockPay(a, first.body.checkout.orderId);
  const res = await a.post('/api/payments/verify').send(paid);
  assert.equal(res.body.outcome, 'refunded_slot_taken');
  assert.equal(res.body.booking.status, 'expired');
  assert.equal(res.body.booking.payment.status, 'refunded');
  assert.equal(res.body.booking.payment.refunded_paise, res.body.booking.total_paise);
});

test('paying for a booking that was cancelled meanwhile is refunded', async () => {
  const c = await newClient('Changed mind');
  const { booking, checkout } = await startBooking(c, 6);
  const paid = await mockPay(c, checkout.orderId);
  await c.post(`/api/bookings/${booking.id}/cancel`).send({});
  const res = await c.post('/api/payments/verify').send(paid);
  // The open order was closed on cancel, so the late capture is refunded
  assert.ok(['refunded_cancelled', 'already'].includes(res.body.outcome), res.body.outcome);
  const { rows } = await query(`SELECT status FROM payments WHERE booking_id = $1`, [booking.id]);
  assert.ok(rows.every((r) => r.status !== 'captured'));
});

test('Razorpay checkout signature: HMAC-SHA256(order|payment, key secret)', () => {
  const sig = crypto.createHmac('sha256', 'rzp_secret_test').update('order_1|pay_1').digest('hex');
  assert.equal(razorpayProvider.verifyCheckout({ orderId: 'order_1', paymentId: 'pay_1', signature: sig }), true);
  assert.equal(razorpayProvider.verifyCheckout({ orderId: 'order_1', paymentId: 'pay_2', signature: sig }), false);
});

test('Razorpay webhook: signature checked, capture confirms, duplicates ignored, failures recorded', async () => {
  const c = await newClient('Webhooked');
  const { booking } = await startBooking(c, 8);
  // Simulate a booking whose order was created with Razorpay
  await query(`UPDATE payments SET provider = 'razorpay', provider_order_id = 'order_WH1' WHERE booking_id = $1`, [booking.id]);
  const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_WH1', order_id: 'order_WH1' } } } });
  const sign = (b) => crypto.createHmac('sha256', 'whsec_test').update(b).digest('hex');

  const bad = await request(app).post('/api/payments/webhook/razorpay').set('content-type', 'application/json')
    .set('x-razorpay-signature', 'nope').send(body);
  assert.equal(bad.status, 400);

  const send = () => request(app).post('/api/payments/webhook/razorpay').set('content-type', 'application/json')
    .set('x-razorpay-signature', sign(body)).set('x-razorpay-event-id', 'evt_1').send(body);
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);   // retried delivery
  const b = (await c.get(`/api/bookings/${booking.id}`)).body.booking;
  assert.equal(b.status, 'confirmed');
  assert.equal(b.payment.status, 'captured');
  const { rows } = await query(`SELECT count(*)::int n FROM payment_events WHERE event_id = 'evt_1'`);
  assert.equal(rows[0].n, 1);

  // payment.failed for another order
  const c2 = await newClient('Webhook fail');
  const { booking: b2 } = await startBooking(c2, 9);
  await query(`UPDATE payments SET provider = 'razorpay', provider_order_id = 'order_WH2' WHERE booking_id = $1`, [b2.id]);
  const fbody = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_WH2', order_id: 'order_WH2', error_description: 'Insufficient funds' } } } });
  await request(app).post('/api/payments/webhook/razorpay').set('content-type', 'application/json')
    .set('x-razorpay-signature', sign(fbody)).set('x-razorpay-event-id', 'evt_2').send(fbody);
  const p2 = (await c2.get(`/api/bookings/${b2.id}`)).body.booking.payment;
  assert.equal(p2.status, 'failed');
  assert.equal(p2.failure_reason, 'Insufficient funds');
});
