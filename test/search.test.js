import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, resetDb, pool } from './helpers.js';

before(resetDb);
after(() => pool.end());

const haversine = (a, b) => {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

test('returns only lawyers inside the radius, nearest first', async () => {
  const res = await request(app).get('/api/lawyers?area=Bandra%20West&radiusKm=5');
  assert.equal(res.status, 200);
  assert.ok(res.body.count > 0);
  const centre = res.body.centre;
  let prev = -1;
  for (const l of res.body.lawyers) {
    const d = haversine(centre, l);
    assert.ok(d <= 5.05, `${l.name} is ${d}km away`);
    assert.ok(l.distance_km >= prev); prev = l.distance_km;
  }
  // Everyone outside 5km is excluded: compare with a wide search
  const wide = await request(app).get('/api/lawyers?area=Bandra%20West&radiusKm=50');
  const outside = wide.body.lawyers.filter((l) => haversine(centre, l) > 5.05);
  assert.ok(outside.length > 0);
  assert.ok(outside.every((o) => !res.body.lawyers.some((l) => l.id === o.id)));
});

test('accepts browser coordinates and widening the radius finds more', async () => {
  const near = await request(app).get('/api/lawyers?lat=19.1176&lng=72.9060&radiusKm=2');
  const far = await request(app).get('/api/lawyers?lat=19.1176&lng=72.9060&radiusKm=25');
  assert.ok(near.body.count < far.body.count);
  assert.equal(near.body.lawyers[0].area, 'Powai');
});

test('filters by specialization, fee, mode and language; sorts by fee', async () => {
  const res = await request(app).get('/api/lawyers?radiusKm=50&specialization=family&maxFee=2000&mode=phone&language=Hindi&sort=fee');
  assert.ok(res.body.count > 0);
  let prev = 0;
  for (const l of res.body.lawyers) {
    assert.ok(l.specializations.some((s) => s.slug === 'family'));
    assert.ok(l.fee_paise <= 200000);
    assert.ok(Array.isArray(l.modes) && l.modes.includes('phone'));
    assert.ok(l.languages.includes('Hindi'));
    assert.ok(l.fee_paise >= prev); prev = l.fee_paise;
    assert.equal(l.price.total_paise, l.price.fee_paise + l.price.platform_fee_paise);
  }
});

test('rejects unknown areas and bad radii; pending lawyers never appear', async () => {
  assert.equal((await request(app).get('/api/lawyers?area=Atlantis')).status, 400);
  assert.equal((await request(app).get('/api/lawyers?radiusKm=500')).status, 400);
  const all = await request(app).get('/api/lawyers?radiusKm=50');
  assert.ok(all.body.lawyers.every((l) => l.verification_status === 'verified'));
  assert.ok(!all.body.lawyers.some((l) => l.name.includes('Tejas')));
});

test('profile, slots and meta endpoints', async () => {
  const list = await request(app).get('/api/lawyers?radiusKm=50');
  const id = list.body.lawyers[0].id;
  const p = await request(app).get(`/api/lawyers/${id}`);
  assert.equal(p.status, 200);
  assert.ok(p.body.availability.length > 0);
  assert.ok(Array.isArray(p.body.reviews));
  assert.equal((await request(app).get(`/api/lawyers/${id}/slots?date=nope`)).status, 400);
  const meta = await request(app).get('/api/meta');
  assert.ok(meta.body.cities.find((c) => c.slug === 'mumbai').is_live);
  assert.ok(meta.body.cities.length >= 8);
});
