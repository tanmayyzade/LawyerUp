import { config } from '../config.js';

const OFFSET_MS = config.tzOffsetMinutes * 60_000;

/** 'YYYY-MM-DD' + 'HH:MM' in IST -> Date (UTC instant). */
export function istToDate(day, hhmm) {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, min) - OFFSET_MS);
}

/** Date -> { day: 'YYYY-MM-DD', time: 'HH:MM', weekday } as seen in IST. */
export function dateToIst(date) {
  const t = new Date(date.getTime() + OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    day: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    time: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
    weekday: t.getUTCDay(),
  };
}

export function weekdayOf(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const toMinutes = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
export const fromMinutes = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
