import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, resetDb, login, pool, query } from './helpers.js';
import { _setExchangeForTests } from '../src/providers/google.js';

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (claims) => `${enc({ alg: 'RS256' })}.${enc({
  iss: 'https://accounts.google.com', aud: 'test-client.apps.googleusercontent.com',
  exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...claims })}.sig`;
let nextClaims; let lastExchange;
_setExchangeForTests(async (args) => { lastExchange = args; return { id_token: idToken(nextClaims) }; });

before(resetDb);
after(() => pool.end());

/** Runs start → (pretend Google) → callback with the same browser. */
async function signInWithGoogle(claims, { next, tamperState } = {}) {
  nextClaims = claims;
  const agent = request.agent(app);
  const start = await agent.get(`/api/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  assert.equal(start.status, 302);
  const url = new URL(start.headers.location);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const state = tamperState ? 'forged' : url.searchParams.get('state');
  const cb = await agent.get(`/api/auth/google/callback?code=abc&state=${state}`);
  return { agent, start: url, cb };
}

test('start sends the browser to Google with PKCE and the right scopes', async () => {
  const { start } = await signInWithGoogle({ sub: 'g-1', email: 'new.person@gmail.com', name: 'New Person' });
  assert.equal(start.searchParams.get('client_id'), 'test-client.apps.googleusercontent.com');
  assert.equal(start.searchParams.get('scope'), 'openid email profile');
  assert.equal(start.searchParams.get('code_challenge_method'), 'S256');
  assert.match(start.searchParams.get('redirect_uri'), /\/api\/auth\/google\/callback$/);
  assert.ok(lastExchange.verifier.length >= 43);
});

test('new Google user gets a client account and is asked for a mobile number before booking', async () => {
  const { agent, cb } = await signInWithGoogle({ sub: 'g-2', email: 'Asha.Rao@gmail.com', name: 'Asha Rao', picture: 'https://x/p.png' }, { next: '#/lawyers/abc' });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.location, `/#/complete-profile?next=${encodeURIComponent('#/lawyers/abc')}`);
  const me = (await agent.get('/api/auth/me')).body.user;
  assert.equal(me.email, 'asha.rao@gmail.com');
  assert.equal(me.role, 'client');
  assert.equal(me.needsPhone, true);
  assert.deepEqual(me.signIn, { password: false, google: true });

  const { rows: [l] } = await query(`SELECT id FROM users WHERE email = 'lawyer@lawyerup.dev'`);
  const blocked = await agent.post('/api/bookings').send({ lawyerId: l.id, startsAt: new Date().toISOString(), mode: 'video' });
  assert.equal(blocked.body.error.code, 'phone_required');

  const otp = await agent.post('/api/auth/otp/request').send({ phone: '9811122233' });
  const added = await agent.post('/api/auth/phone').send({ phone: '9811122233', otpCode: otp.body.devCode });
  assert.equal(added.status, 200);
  assert.equal(added.body.user.phone, '+919811122233');
  assert.equal(added.body.user.needsPhone, false);

  // Password login is refused politely for Google-only accounts
  const pw = await request(app).post('/api/auth/login').send({ email: 'asha.rao@gmail.com', password: 'whatever1' });
  assert.equal(pw.status, 401);
  assert.match(pw.body.error.message, /Google/);
});

test('signing in again finds the same account; an existing email account is linked, not duplicated', async () => {
  await signInWithGoogle({ sub: 'g-3', email: 'repeat@gmail.com', name: 'Repeat User' });
  const { agent } = await signInWithGoogle({ sub: 'g-3', email: 'repeat@gmail.com', name: 'Repeat User' });
  const { rows } = await query(`SELECT count(*)::int n FROM users WHERE lower(email) = 'repeat@gmail.com'`);
  assert.equal(rows[0].n, 1);
  assert.equal((await agent.get('/api/auth/me')).body.user.email, 'repeat@gmail.com');

  // The seeded demo client signs in with Google using the same email → linked, keeps phone & role
  const linked = await signInWithGoogle({ sub: 'g-4', email: 'client@lawyerup.dev', name: 'Demo Client' });
  assert.equal(linked.cb.headers.location, '/#/find');
  const me = (await linked.agent.get('/api/auth/me')).body.user;
  assert.equal(me.signIn.google, true);
  assert.equal(me.signIn.password, true);
  assert.equal(me.needsPhone, false);
  // and a lawyer lands in the practice portal
  const lw = await signInWithGoogle({ sub: 'g-5', email: 'lawyer@lawyerup.dev', name: 'Aditi' });
  assert.equal(lw.cb.headers.location, '/#/practice');
});

test('rejects forged state, unverified emails, wrong audience and expired sessions', async () => {
  const forged = await signInWithGoogle({ sub: 'g-6', email: 'x@gmail.com' }, { tamperState: true });
  assert.equal(forged.cb.headers.location, '/#/login?error=google_state');
  assert.equal((await forged.agent.get('/api/auth/me')).body.user, null);

  const unverified = await signInWithGoogle({ sub: 'g-7', email: 'y@gmail.com', email_verified: false });
  assert.equal(unverified.cb.headers.location, '/#/login?error=google_unverified');

  const wrongAud = await signInWithGoogle({ sub: 'g-8', email: 'z@gmail.com', aud: 'someone-else' });
  assert.equal(wrongAud.cb.headers.location, '/#/login?error=google_failed');

  const noCookie = await request(app).get('/api/auth/google/callback?code=abc&state=whatever');
  assert.equal(noCookie.headers.location, '/#/login?error=google_expired');

  const { rows } = await query(`SELECT count(*)::int n FROM users WHERE email IN ('x@gmail.com','y@gmail.com','z@gmail.com')`);
  assert.equal(rows[0].n, 0);
});

test('open redirects are not possible through ?next', async () => {
  const { cb } = await signInWithGoogle({ sub: 'g-9', email: 'safe@gmail.com', name: 'Safe User' }, { next: 'https://evil.example/' });
  assert.equal(cb.headers.location, `/#/complete-profile?next=${encodeURIComponent('#/find')}`);
});

test('meta tells the UI Google sign-in is available', async () => {
  assert.equal((await request(app).get('/api/meta')).body.googleSignIn, true);
});
