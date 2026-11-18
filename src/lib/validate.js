import { badRequest } from './errors.js';

export function str(v, name, { min = 1, max = 500, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw badRequest(`${name} is required.`);
  }
  if (typeof v !== 'string') throw badRequest(`${name} must be text.`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw badRequest(`${name} must be ${min}–${max} characters.`);
  return s;
}

export function int(v, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw badRequest(`${name} is required.`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be a whole number between ${min} and ${max}.`);
  return n;
}

export function num(v, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw badRequest(`${name} is required.`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${name} is out of range.`);
  return n;
}

export function oneOf(v, name, options, { optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw badRequest(`${name} is required.`);
  }
  if (!options.includes(v)) throw badRequest(`${name} must be one of: ${options.join(', ')}.`);
  return v;
}

export function email(v) {
  const s = str(v, 'Email', { max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw badRequest('Enter a valid email address.');
  return s;
}

/** Normalise Indian mobile numbers to +91XXXXXXXXXX. */
export function phone(v) {
  const digits = String(v || '').replace(/\D/g, '');
  const ten = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  if (!/^[6-9]\d{9}$/.test(ten)) throw badRequest('Enter a valid 10-digit Indian mobile number.');
  return `+91${ten}`;
}

export function password(v) {
  const s = typeof v === 'string' ? v : '';
  if (s.length < 8 || s.length > 128 || !/[A-Za-z]/.test(s) || !/\d/.test(s)) {
    throw badRequest('Password must be at least 8 characters and include a letter and a number.');
  }
  return s;
}

export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Guard against confidential identifiers being typed into free text at this stage. */
export function rejectSensitive(text, name) {
  if (!text) return text;
  if (/\b\d{4}\s?\d{4}\s?\d{4}\b/.test(text)) {
    throw badRequest(`${name} looks like it contains an Aadhaar or ID number. Please remove it — LawyerUp never needs it here.`);
  }
  return text;
}
