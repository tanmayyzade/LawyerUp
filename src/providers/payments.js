// Payment providers. Choose with PAYMENT_PROVIDER=mock|razorpay.
// The rest of the app only talks to this interface:
//   createOrder({ amountPaise, receipt, notes }) -> { orderId, checkout }
//   verifyCheckout({ orderId, paymentId, signature }) -> boolean
//   verifyWebhook(rawBody, signatureHeader) -> boolean
//   refund({ paymentId, amountPaise }) -> { refundId }
import crypto from 'node:crypto';
import { config } from '../config.js';
import { safeEqual } from '../lib/security.js';

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

export const mockProvider = {
  name: 'mock',
  async createOrder({ amountPaise }) {
    const orderId = `mock_order_${crypto.randomBytes(8).toString('hex')}`;
    return { orderId, checkout: { provider: 'mock', orderId, amount: amountPaise, currency: 'INR' } };
  },
  /** Signature a test-mode checkout would produce. Exposed only so the simulate endpoint can use it. */
  sign(orderId, paymentId) { return hmac(`mock-secret:${config.jwtSecret}`, `${orderId}|${paymentId}`); },
  verifyCheckout({ orderId, paymentId, signature }) {
    return Boolean(signature) && safeEqual(this.sign(orderId, paymentId), signature);
  },
  verifyWebhook() { return false; },
  async refund() { return { refundId: `mock_rfnd_${crypto.randomBytes(6).toString('hex')}` }; },
};

export const razorpayProvider = {
  name: 'razorpay',
  _auth() {
    const { razorpayKeyId: id, razorpayKeySecret: secret } = config.payments;
    if (!id || !secret) throw new Error('Razorpay is selected but RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set.');
    return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
  },
  async _post(path, body) {
    const res = await fetch(`https://api.razorpay.com/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: this._auth() },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Razorpay ${path} failed: ${json?.error?.description || res.status}`);
    return json;
  },
  async createOrder({ amountPaise, receipt, notes }) {
    const order = await this._post('/orders', { amount: amountPaise, currency: 'INR', receipt, notes });
    return {
      orderId: order.id,
      checkout: { provider: 'razorpay', keyId: config.payments.razorpayKeyId, orderId: order.id, amount: amountPaise, currency: 'INR' },
    };
  },
  // https://razorpay.com/docs/payments/server-integration/nodejs/integration-steps/#verify-payment-signature
  verifyCheckout({ orderId, paymentId, signature }) {
    if (!signature || !config.payments.razorpayKeySecret) return false;
    return safeEqual(hmac(config.payments.razorpayKeySecret, `${orderId}|${paymentId}`), signature);
  },
  verifyWebhook(rawBody, signatureHeader) {
    const secret = config.payments.razorpayWebhookSecret;
    if (!secret || !signatureHeader || !rawBody) return false;
    return safeEqual(hmac(secret, rawBody), signatureHeader);
  },
  async refund({ paymentId, amountPaise }) {
    const r = await this._post(`/payments/${paymentId}/refund`, { amount: amountPaise, speed: 'normal' });
    return { refundId: r.id };
  },
};

const providers = { mock: mockProvider, razorpay: razorpayProvider };

export function paymentProvider(name = config.payments.provider) {
  const p = providers[name];
  if (!p) throw new Error(`Unknown PAYMENT_PROVIDER "${name}"`);
  return p;
}

export const _hmacForTests = hmac;
