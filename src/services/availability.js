import { config } from '../config.js';
import { istToDate, dateToIst, weekdayOf, toMinutes, fromMinutes } from '../lib/time.js';

/** Mark unpaid holds whose timer ran out as expired, freeing their slots. */
export async function expireStaleHolds(db) {
  const { rowCount } = await db.query(
    `UPDATE bookings SET status = 'expired', updated_at = now()
      WHERE status = 'pending_payment' AND hold_expires_at < now()`);
  return rowCount;
}

/**
 * Bookable slots for a lawyer on an IST calendar day.
 * Returns [{ startsAt, endsAt, time, available }] — taken/past slots are included with available=false
 * so the UI can show the full day.
 */
export async function slotsForDay(db, lawyerId, day, { now = new Date() } = {}) {
  const { rows: [profile] } = await db.query(
    'SELECT session_minutes FROM lawyer_profiles WHERE user_id = $1', [lawyerId]);
  if (!profile) return [];
  const len = profile.session_minutes;

  const earliest = new Date(now.getTime() + config.minLeadMinutes * 60_000);
  const latest = new Date(now.getTime() + config.bookingHorizonDays * 86_400_000);

  // Sequential on purpose: `db` may be a single transaction client.
  const { rows: rules } = await db.query(`SELECT to_char(start_time,'HH24:MI') AS s, to_char(end_time,'HH24:MI') AS e
                FROM availability_rules WHERE lawyer_id = $1 AND weekday = $2 ORDER BY start_time`,
      [lawyerId, weekdayOf(day)]);
  const { rows: blocks } = await db.query('SELECT 1 FROM availability_blocks WHERE lawyer_id = $1 AND day = $2', [lawyerId, day]);
  const { rows: taken } = await db.query(`SELECT starts_at, ends_at FROM bookings
               WHERE lawyer_id = $1 AND status IN ('pending_payment','confirmed')
                 AND (hold_expires_at IS NULL OR status = 'confirmed' OR hold_expires_at > now())
                 AND starts_at < $3 AND ends_at > $2`,
      [lawyerId, istToDate(day, '00:00'), istToDate(day, '23:59')]);
  if (blocks.length) return [];

  const slots = [];
  for (const r of rules) {
    for (let m = toMinutes(r.s); m + len <= toMinutes(r.e); m += len) {
      const startsAt = istToDate(day, fromMinutes(m));
      const endsAt = new Date(startsAt.getTime() + len * 60_000);
      const clash = taken.some((b) => b.starts_at < endsAt && b.ends_at > startsAt);
      const inWindow = startsAt >= earliest && startsAt <= latest;
      slots.push({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), time: fromMinutes(m), available: inWindow && !clash });
    }
  }
  return slots;
}

/** Is `startsAt` exactly one of the lawyer's published slot starts (ignoring whether it's taken)? */
export async function isPublishedSlot(db, lawyerId, startsAt, { now = new Date() } = {}) {
  const { day } = dateToIst(startsAt);
  const slots = await slotsForDay(db, lawyerId, day, { now });
  const match = slots.find((s) => s.startsAt === startsAt.toISOString());
  if (!match) return { ok: false, reason: 'not_offered' };
  const earliest = new Date(now.getTime() + config.minLeadMinutes * 60_000);
  const latest = new Date(now.getTime() + config.bookingHorizonDays * 86_400_000);
  if (startsAt < earliest) return { ok: false, reason: 'too_soon' };
  if (startsAt > latest) return { ok: false, reason: 'too_far' };
  return { ok: true, endsAt: new Date(match.endsAt) };
}
