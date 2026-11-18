// Meeting links for video consultations. VIDEO_PROVIDER=jitsi|none.
import crypto from 'node:crypto';
import { config } from '../config.js';

export function meetingUrlFor(booking) {
  if (booking.mode !== 'video' || config.video.provider === 'none') return null;
  // Unguessable room name per booking. Swap for Daily/Twilio/100ms rooms with expiring tokens in production.
  const room = `LawyerUp-${crypto.randomBytes(9).toString('base64url')}`;
  return `${config.video.jitsiBaseUrl.replace(/\/$/, '')}/${room}`;
}
