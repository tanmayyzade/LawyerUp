import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import * as v from '../lib/validate.js';
import { isDay } from '../lib/time.js';
import { priceBreakdown } from '../lib/money.js';
import { slotsForDay } from '../services/availability.js';

const r = Router();

const DISTANCE_SQL = (latP, lngP) => `(6371 * 2 * asin(sqrt(
    power(sin(radians(lp.lat - ${latP}) / 2), 2) +
    cos(radians(${latP})) * cos(radians(lp.lat)) * power(sin(radians(lp.lng - ${lngP}) / 2), 2))))`;

const LAWYER_CARD = `
  u.id, u.name, lp.headline, lp.experience_years, lp.languages, lp.photo_url, lp.area, c.name AS city,
  lp.fee_paise, lp.session_minutes, lp.modes::text[] AS modes, lp.rating_avg, lp.rating_count, lp.lat, lp.lng,
  lp.bar_council, lp.enrollment_year, lp.verification_status,
  COALESCE((SELECT json_agg(json_build_object('slug', s.slug, 'name', s.name) ORDER BY s.name)
              FROM lawyer_specializations ls JOIN specializations s ON s.id = ls.specialization_id
             WHERE ls.lawyer_id = lp.user_id), '[]') AS specializations`;

const withPrice = (row) => ({ ...row, price: priceBreakdown(row.fee_paise) });

r.get('/meta', ah(async (_req, res) => {
  const [cities, specs, langs] = await Promise.all([
    query('SELECT slug, name, state, lat, lng, is_live FROM cities ORDER BY is_live DESC, name'),
    query('SELECT slug, name FROM specializations ORDER BY name'),
    query(`SELECT DISTINCT unnest(languages) AS l FROM lawyer_profiles WHERE verification_status = 'verified' ORDER BY 1`),
  ]);
  res.json({
    cities: cities.rows,
    specializations: specs.rows,
    languages: langs.rows.map((r) => r.l),
    defaultCity: config.defaultCity,
    platformFeePercent: config.platformFeeBps / 100,
    freeCancelHours: config.freeCancelHours,
    bookingHoldMinutes: config.bookingHoldMinutes,
    payments: { provider: config.payments.provider, razorpayKeyId: config.payments.provider === 'razorpay' ? config.payments.razorpayKeyId : null },
  });
}));

/** Locality lookup (our own geocoder for launch cities — no external API key needed). */
r.get('/places', ah(async (req, res) => {
  const city = req.query.city || config.defaultCity;
  const q = String(req.query.q || '').trim();
  const { rows } = await query(
    `SELECT l.name, l.lat, l.lng, c.slug AS city FROM localities l JOIN cities c ON c.id = l.city_id
      WHERE c.slug = $1 AND ($2 = '' OR l.name ILIKE '%' || $2 || '%') ORDER BY l.name LIMIT 50`, [city, q]);
  res.json({ places: rows });
}));

/**
 * Search verified lawyers within a radius.
 *   lat,lng | area (+city)  — the search centre (defaults to the city centre)
 *   radiusKm (1–50, default 10), specialization, language, mode, maxFee (₹), minRating, q, sort=distance|fee|rating|experience
 */
r.get('/lawyers', ah(async (req, res) => {
  const qs = req.query;
  const citySlug = qs.city || config.defaultCity;
  const { rows: [city] } = await query('SELECT id, slug, name, lat, lng FROM cities WHERE slug = $1', [citySlug]);
  if (!city) throw badRequest('Unknown city.');

  let lat = v.num(qs.lat, 'lat', { min: 6, max: 38, optional: true });
  let lng = v.num(qs.lng, 'lng', { min: 68, max: 98, optional: true });
  let centreLabel = 'your location';
  if (lat === null || lng === null) {
    if (qs.area) {
      const { rows: [loc] } = await query('SELECT name, lat, lng FROM localities WHERE city_id = $1 AND lower(name) = lower($2)', [city.id, qs.area]);
      if (!loc) throw badRequest(`We couldn't find "${qs.area}" in ${city.name}.`);
      ({ lat, lng } = loc); centreLabel = loc.name;
    } else {
      ({ lat, lng } = city); centreLabel = `${city.name} centre`;
    }
  }
  const radiusKm = v.num(qs.radiusKm ?? 10, 'radiusKm', { min: 1, max: 50 });
  const sort = v.oneOf(qs.sort || 'distance', 'sort', ['distance', 'fee', 'rating', 'experience']);
  const mode = v.oneOf(qs.mode, 'mode', ['video', 'phone', 'in_person'], { optional: true });
  const maxFee = v.int(qs.maxFee, 'maxFee', { min: 0, max: 100000, optional: true });
  const minRating = v.num(qs.minRating, 'minRating', { min: 0, max: 5, optional: true });
  const text = v.str(qs.q, 'q', { max: 80, optional: true });

  // Degree bounding box first (cheap, uses the lat/lng index), then exact great-circle distance.
  const dLat = radiusKm / 111.0;
  const dLng = radiusKm / (111.0 * Math.cos((lat * Math.PI) / 180));

  const params = [lat, lng, radiusKm, lat - dLat, lat + dLat, lng - dLng, lng + dLng];
  const where = [`lp.verification_status = 'verified'`, 'u.is_active',
    'lp.lat BETWEEN $4 AND $5', 'lp.lng BETWEEN $6 AND $7'];
  const add = (sql, val) => { params.push(val); where.push(sql.replaceAll('?', `$${params.length}`)); };

  if (qs.specialization) add(`EXISTS (SELECT 1 FROM lawyer_specializations ls JOIN specializations s ON s.id = ls.specialization_id
                                       WHERE ls.lawyer_id = lp.user_id AND s.slug = ?)`, String(qs.specialization));
  if (qs.language) add('? = ANY(lp.languages)', String(qs.language));
  if (mode) add('?::consult_mode = ANY(lp.modes)', mode);
  if (maxFee !== null) add('lp.fee_paise <= ?', maxFee * 100);
  if (minRating !== null) add('lp.rating_avg >= ?', minRating);
  if (text) add(`(u.name ILIKE '%' || ? || '%' OR lp.headline ILIKE '%' || ? || '%' OR lp.area ILIKE '%' || ? || '%')`, text);

  const order = {
    distance: 'distance_km ASC',
    fee: 'lp.fee_paise ASC, distance_km ASC',
    rating: 'lp.rating_avg DESC, lp.rating_count DESC',
    experience: 'lp.experience_years DESC',
  }[sort];

  const { rows } = await query(
    `SELECT * FROM (
       SELECT ${LAWYER_CARD}, ${DISTANCE_SQL('$1', '$2')} AS distance_km
         FROM lawyer_profiles lp JOIN users u ON u.id = lp.user_id JOIN cities c ON c.id = lp.city_id
        WHERE ${where.join(' AND ')}
     ) lp WHERE distance_km <= $3 ORDER BY ${order.replaceAll('lp.', '')} LIMIT 100`, params);

  res.json({
    centre: { lat, lng, label: centreLabel, city: city.slug },
    radiusKm,
    count: rows.length,
    lawyers: rows.map((row) => withPrice({ ...row, distance_km: Math.round(row.distance_km * 10) / 10 })),
  });
}));

r.get('/lawyers/:id', ah(async (req, res) => {
  if (!v.isUuid(req.params.id)) throw notFound('Lawyer not found.');
  const { rows: [lawyer] } = await query(
    `SELECT ${LAWYER_CARD}, lp.bio, lp.office_address, lp.enrollment_number, lp.verified_at
       FROM lawyer_profiles lp JOIN users u ON u.id = lp.user_id JOIN cities c ON c.id = lp.city_id
      WHERE lp.user_id = $1 AND lp.verification_status = 'verified' AND u.is_active`, [req.params.id]);
  if (!lawyer) throw notFound('Lawyer not found.');
  const [{ rows: availability }, { rows: reviews }] = await Promise.all([
    query(`SELECT weekday, to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS end
             FROM availability_rules WHERE lawyer_id = $1 ORDER BY weekday, start_time`, [lawyer.id]),
    query(`SELECT r.rating, r.comment, r.created_at, split_part(u.name, ' ', 1) AS client_first_name
             FROM reviews r JOIN users u ON u.id = r.client_id WHERE r.lawyer_id = $1 ORDER BY r.created_at DESC LIMIT 20`, [lawyer.id]),
  ]);
  res.json({ lawyer: withPrice(lawyer), availability, reviews });
}));

r.get('/lawyers/:id/slots', ah(async (req, res) => {
  if (!v.isUuid(req.params.id)) throw notFound('Lawyer not found.');
  const day = req.query.date;
  if (!isDay(day)) throw badRequest('date must be YYYY-MM-DD.');
  const { rowCount } = await query(`SELECT 1 FROM lawyer_profiles WHERE user_id = $1 AND verification_status = 'verified'`, [req.params.id]);
  if (!rowCount) throw notFound('Lawyer not found.');
  res.json({ date: day, slots: await slotsForDay({ query }, req.params.id, day) });
}));

export default r;
