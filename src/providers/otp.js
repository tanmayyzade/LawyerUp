// OTP delivery. OTP_PROVIDER=console prints codes to the server log (development only).
import { config } from '../config.js';

const consoleProvider = {
  name: 'console',
  async send(phone, code) {
    if (!config.isTest) console.log(`[otp] ${phone} -> ${code}  (console provider: not sent by SMS)`);
  },
  exposesCodeInDev: true,
};

const msg91Provider = {
  name: 'msg91',
  async send(phone, code) {
    const { msg91AuthKey, msg91TemplateId } = config.otp;
    if (!msg91AuthKey || !msg91TemplateId) throw new Error('MSG91_AUTH_KEY / MSG91_TEMPLATE_ID are not set.');
    const res = await fetch('https://control.msg91.com/api/v5/otp?' + new URLSearchParams({
      template_id: msg91TemplateId, mobile: phone.replace('+', ''), otp: code,
    }), { method: 'POST', headers: { authkey: msg91AuthKey } });
    if (!res.ok) throw new Error(`MSG91 send failed (${res.status})`);
  },
  exposesCodeInDev: false,
};

export function otpProvider() {
  return { console: consoleProvider, msg91: msg91Provider }[config.otp.provider] || consoleProvider;
}
