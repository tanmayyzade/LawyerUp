process.env.NODE_ENV = 'test';
process.env.PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || 'mock';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
process.env.RAZORPAY_KEY_SECRET = 'rzp_secret_test';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

import request from 'supertest';
const { createApp } = await import('../src/app.js');
const { migrate } = await import('../src/db/migrate.js');
const { seed, DEMO_PASSWORD } = await import('../src/db/seed.js');
const { pool, query } = await import('../src/db/pool.js');

export { pool, query, DEMO_PASSWORD };
export const app = createApp();

export async function resetDb() {
  await migrate({ reset: true, log: () => {} });
  await seed({ log: () => {} });
}

/** A supertest agent (keeps the session cookie) signed in as `email`. */
export async function login(email, password = DEMO_PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  agent.user = res.body.user;
  return agent;
}

let phoneSeq = 0;
/** Register a brand-new client through the real OTP flow. */
export async function newClient(name = 'Test Client', { kyc = true } = {}) {
  phoneSeq += 1;
  const phone = `97${String(Date.now()).slice(-6)}${String(phoneSeq).padStart(2, '0')}`;
  const agent = request.agent(app);
  const otp = await agent.post('/api/auth/otp/request').send({ phone });
  const res = await agent.post('/api/auth/register').send({
    role: 'client', name, email: `c${phone}@example.com`, phone, password: 'Passw0rd!', otpCode: otp.body.devCode,
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  if (kyc) await agent.post('/api/auth/kyc/start').send({});
  agent.user = res.body.user;
  return agent;
}

export async function lawyerByEmail(email) {
  return (await query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
}

/** First bookable slot for a lawyer, scanning forward from tomorrow. `skip` returns a later one. */
export async function nextSlot(lawyerId, skip = 0) {
  const found = [];
  for (let d = 1; d <= 14; d++) {
    const day = new Date(Date.now() + d * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
    const res = await request(app).get(`/api/lawyers/${lawyerId}/slots?date=${day}`);
    for (const s of res.body.slots || []) if (s.available) found.push(s);
    if (found.length > skip) return found[skip];
  }
  throw new Error('no slot found');
}

/** Book and pay with the mock gateway. Returns { booking, checkout }. */
export async function bookAndPay(agent, lawyerId, slot, mode = 'video') {
  const created = await agent.post('/api/bookings').send({ lawyerId, startsAt: slot.startsAt, mode, issueSummary: 'Test topic' });
  if (created.status !== 201) throw new Error(`booking failed: ${JSON.stringify(created.body)}`);
  const { checkout } = created.body;
  const pay = await agent.post('/api/payments/mock/checkout').send({ orderId: checkout.orderId, outcome: 'success' });
  const verify = await agent.post('/api/payments/verify').send({ orderId: pay.body.orderId, paymentId: pay.body.paymentId, signature: pay.body.signature });
  if (verify.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verify.body)}`);
  return { booking: verify.body.booking, checkout };
}
