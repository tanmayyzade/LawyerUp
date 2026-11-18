// Minimal RFC 5545 calendar file for one consultation (works with Google, Apple and Outlook calendars).
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// Lines longer than 75 octets must be folded.
const fold = (line) => {
  const out = []; let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let n = 75; while (Buffer.byteLength(rest.slice(0, n)) > 75) n--;
    out.push(rest.slice(0, n)); rest = ` ${rest.slice(n)}`;
  }
  out.push(rest);
  return out.join('\r\n');
};

const MODE = { video: 'Video call', phone: 'Phone call', in_person: 'In person' };

export function bookingIcs(b, viewer, siteUrl) {
  const other = viewer === 'lawyer' ? b.client_name : b.lawyer_name;
  const where = b.mode === 'video' ? (b.meeting_url || 'Video link in your LawyerUp booking')
    : b.mode === 'phone' ? (viewer === 'lawyer' ? `Call ${b.client_phone || 'the client'}` : 'Your lawyer will call your registered mobile number')
      : (b.office_address || b.lawyer_area || 'Lawyer\'s office');
  const link = `${siteUrl}/#/bookings/${b.id}`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LawyerUp//Consultations//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${b.id}@lawyerup`,
    `SEQUENCE:${b.reschedule_count || 0}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(b.starts_at)}`,
    `DTEND:${stamp(b.ends_at)}`,
    `SUMMARY:${esc(`LawyerUp: ${MODE[b.mode]} with ${other}`)}`,
    `LOCATION:${esc(where)}`,
    `DESCRIPTION:${esc(`${b.issue_summary ? `Topic: ${b.issue_summary}\n` : ''}Manage this booking: ${link}`)}`,
    `URL:${link}`,
    'STATUS:CONFIRMED',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Consultation tomorrow', 'TRIGGER:-PT24H', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Consultation in 15 minutes', 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
