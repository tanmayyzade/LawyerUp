import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, resetDb, login, pool, query } from './helpers.js';

before(resetDb);
after(() => pool.end());

test('registration requires a valid OTP', async () => {
  const agent = request.agent(app);
  const phone = '9123456780';
  const otp = await agent.post('/api/auth/otp/request').send({ phone });
  assert.equal(otp.status, 200);
  assert.match(otp.body.devCode, /^\d{6}$/);

  const base = { role: 'client', name: 'Asha', email: 'asha@example.com', phone, password: 'Secret123' };
  const wrongCode = otp.body.devCode === '000000' ? '111111' : '000000';
  const bad = await agent.post('/api/auth/register').send({ ...base, otpCode: wrongCode });
  assert.equal(bad.status, 400);

  const ok = await agent.post('/api/auth/register').send({ ...base, otpCode: otp.body.devCode });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.role, 'client');
  assert.equal(ok.body.user.phoneVerified, true);

  const me = await agent.get('/api/auth/me');
  assert.equal(me.body.user.email, 'asha@example.com');

  // OTP cannot be reused, and duplicates are rejected
  const again = await request(app).post('/api/auth/register').send({ ...base, email: 'x@example.com', otpCode: otp.body.devCode });
  assert.equal(again.status, 400);
});

test('passwords are hashed, login checks them, logout clears the session', async () => {
  const { rows: [u] } = await query(`SELECT password_hash FROM users WHERE email = 'client@lawyerup.dev'`);
  assert.match(u.password_hash, /^scrypt\$/);

  const bad = await request(app).post('/api/auth/login').send({ email: 'client@lawyerup.dev', password: 'nope' });
  assert.equal(bad.status, 401);

  const agent = await login('client@lawyerup.dev');
  assert.equal((await agent.get('/api/auth/me')).body.user.role, 'client');
  await agent.post('/api/auth/logout').send({});
  assert.equal((await agent.get('/api/auth/me')).body.user, null);
});

test('role guards: anonymous, client, lawyer, admin', async () => {
  assert.equal((await request(app).get('/api/bookings')).status, 401);
  const client = await login('client@lawyerup.dev');
  const lawyer = await login('lawyer@lawyerup.dev');
  const admin = await login('admin@lawyerup.dev');

  assert.equal((await client.get('/api/lawyer/profile')).status, 403);
  assert.equal((await client.get('/api/admin/lawyers')).status, 403);
  assert.equal((await lawyer.get('/api/admin/lawyers')).status, 403);
  assert.equal((await lawyer.get('/api/lawyer/profile')).status, 200);
  assert.equal((await admin.get('/api/admin/lawyers')).status, 200);

  // Lawyers can't book; admins can't be created via sign-up
  assert.equal((await lawyer.post('/api/bookings').send({})).status, 403);
  const otp = await request(app).post('/api/auth/otp/request').send({ phone: '9000000011' });
  const r = await request(app).post('/api/auth/register').send({ role: 'admin', name: 'Evil', email: 'e@x.com', phone: '9000000011', password: 'Secret123', otpCode: otp.body.devCode });
  assert.equal(r.status, 400);
});

test('state-changing API calls must be JSON (CSRF defence)', async () => {
  const client = await login('client@lawyerup.dev');
  const res = await client.post('/api/auth/logout').type('form').send('a=1');
  assert.equal(res.status, 415);
});

test('new lawyers stay hidden until an admin verifies their Bar Council enrolment', async () => {
  const agent = request.agent(app);
  const phone = '9988776655';
  const otp = await agent.post('/api/auth/otp/request').send({ phone });
  const reg = await agent.post('/api/auth/register').send({
    role: 'lawyer', name: 'Adv. New Person', email: 'new.lawyer@example.com', phone, password: 'Secret123', otpCode: otp.body.devCode,
    barCouncil: 'Bar Council of Maharashtra & Goa', enrollmentNumber: 'MAH/9999/2020', enrollmentYear: 2020,
    experienceYears: 5, feeRupees: 999, area: 'Sion', specializations: ['family'], languages: ['English', 'Marathi'],
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const id = reg.body.user.id;

  const hidden = await request(app).get('/api/lawyers?radiusKm=50&q=New%20Person');
  assert.equal(hidden.body.count, 0);
  assert.equal((await request(app).get(`/api/lawyers/${id}`)).status, 404);

  const admin = await login('admin@lawyerup.dev');
  const queue = await admin.get('/api/admin/lawyers?status=pending');
  assert.ok(queue.body.lawyers.some((l) => l.id === id));
  assert.equal((await admin.post(`/api/admin/lawyers/${id}/verification`).send({ decision: 'verified' })).status, 200);

  const visible = await request(app).get('/api/lawyers?radiusKm=50&q=New%20Person');
  assert.equal(visible.body.count, 1);
  assert.equal(visible.body.lawyers[0].price.fee_paise, 99900);

  const audit = await query(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id`, [id]);
  assert.deepEqual(audit.rows.map((r) => r.action), ['user.registered', 'lawyer.verified']);
});

test('free text that looks like an Aadhaar number is refused', async () => {
  const client = await login('client@lawyerup.dev');
  const { rows: [l] } = await query(`SELECT id FROM users WHERE email = 'lawyer@lawyerup.dev'`);
  const res = await client.post('/api/bookings').send({ lawyerId: l.id, startsAt: new Date().toISOString(), mode: 'video', issueSummary: 'My aadhaar is 1234 5678 9012' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /Aadhaar/);
});

test('clients must complete identity verification before booking (no ID data is collected)', async () => {
  const { newClient } = await import('./helpers.js');
  const c = await newClient('Unverified', { kyc: false });
  const { rows: [l] } = await query(`SELECT id FROM users WHERE email = 'lawyer@lawyerup.dev'`);
  const blocked = await c.post('/api/bookings').send({ lawyerId: l.id, startsAt: new Date().toISOString(), mode: 'video' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'kyc_required');
  const kyc = await c.post('/api/auth/kyc/start').send({ aadhaar: '123412341234' });
  assert.equal(kyc.body.kycStatus, 'verified');
  const { rows: [u] } = await query(`SELECT kyc_reference FROM users WHERE id = $1`, [c.user.id]);
  assert.match(u.kyc_reference, /^sbx_/);
  assert.ok(!JSON.stringify(u).includes('123412341234'));
});

test('each audience signs in on its own page', async () => {
  const pw = 'Demo@1234';
  const post = (body) => request(app).post('/api/auth/login').send(body);

  // Right page: signed in.
  assert.equal((await post({ email: 'client@lawyerup.dev', password: pw, portal: 'client' })).status, 200);
  assert.equal((await post({ email: 'lawyer@lawyerup.dev', password: pw, portal: 'lawyer' })).status, 200);
  assert.equal((await post({ email: 'admin@lawyerup.dev', password: pw, portal: 'admin' })).status, 200);

  // Wrong page: no session, and the answer points at the right page.
  const lawyerOnClient = await post({ email: 'lawyer@lawyerup.dev', password: pw, portal: 'client' });
  assert.equal(lawyerOnClient.status, 403);
  assert.equal(lawyerOnClient.body.error.code, 'wrong_portal');
  assert.equal(lawyerOnClient.body.error.details.href, '#/lawyer/login');
  assert.equal(lawyerOnClient.headers['set-cookie'], undefined);
  const clientOnAdmin = await post({ email: 'client@lawyerup.dev', password: pw, portal: 'admin' });
  assert.equal(clientOnAdmin.body.error.details.href, '#/login');

  // A wrong password never reveals which page the account belongs to.
  const guess = await post({ email: 'admin@lawyerup.dev', password: 'nope', portal: 'client' });
  assert.equal(guess.status, 401);
  assert.equal(guess.body.error.code, 'unauthorized');

  // Unknown page names are rejected; admins still can't sign up.
  assert.equal((await post({ email: 'client@lawyerup.dev', password: pw, portal: 'root' })).status, 400);
  const adminSignup = await request(app).post('/api/auth/register').send({ role: 'admin', name: 'X', email: 'x@y.com', phone: '9000000001', password: 'Secret123' });
  assert.equal(adminSignup.status, 400);
});
