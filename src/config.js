import 'dotenv/config';

const env = process.env;
const isTest = env.NODE_ENV === 'test';

function required(name, fallbackForDev) {
  const v = env[name];
  if (v) return v;
  if (env.NODE_ENV === 'production') throw new Error(`Missing required env var ${name}`);
  return fallbackForDev;
}

export const config = {
  env: env.NODE_ENV || 'development',
  isTest,
  isProd: env.NODE_ENV === 'production',
  // Public demo deployment: simulated payments and on-screen OTP stay enabled in production,
  // and sample data is (re)loaded automatically. Never turn this on for a real launch.
  demoMode: env.DEMO_MODE === 'true',
  databaseSsl: env.DATABASE_SSL === 'true',
  port: Number(env.PORT || 4173),
  databaseUrl: isTest
    ? (env.TEST_DATABASE_URL || 'postgres://lawyerup:lawyerup@localhost:5432/lawyerup_test')
    : required('DATABASE_URL', 'postgres://lawyerup:lawyerup@localhost:5432/lawyerup'),
  jwtSecret: required('JWT_SECRET', 'dev-only-secret-change-me'),
  sessionDays: Number(env.SESSION_DAYS || 7),

  // Business rules
  platformFeeBps: Number(env.PLATFORM_FEE_BPS || 1000),         // 1000 bps = 10%
  bookingHoldMinutes: Number(env.BOOKING_HOLD_MINUTES || 10),    // slot held while client pays
  freeCancelHours: Number(env.FREE_CANCEL_HOURS || 4),           // full refund if client cancels this early
  maxClientReschedules: Number(env.MAX_CLIENT_RESCHEDULES || 2),  // per booking; lawyers aren't limited
  minLeadMinutes: Number(env.MIN_LEAD_MINUTES || 60),            // earliest bookable slot from now
  bookingHorizonDays: Number(env.BOOKING_HORIZON_DAYS || 30),
  tzOffsetMinutes: 330,                                          // IST (+05:30, no DST) — whole of India
  defaultCity: env.DEFAULT_CITY || 'mumbai',

  // Providers — swap through environment variables, never code changes
  payments: {
    provider: env.PAYMENT_PROVIDER || 'mock',                   // mock | razorpay
    razorpayKeyId: env.RAZORPAY_KEY_ID || '',
    razorpayKeySecret: env.RAZORPAY_KEY_SECRET || '',
    razorpayWebhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
  },
  otp: {
    provider: env.OTP_PROVIDER || 'console',                    // console | msg91
    msg91AuthKey: env.MSG91_AUTH_KEY || '',
    msg91TemplateId: env.MSG91_TEMPLATE_ID || '',
    ttlMinutes: 10,
    maxAttempts: 5,
  },
  kyc: {
    provider: env.KYC_PROVIDER || 'sandbox',                    // sandbox | (partner AUA/KUA — see README)
    requiredForBooking: env.REQUIRE_KYC_FOR_BOOKING !== 'false',
  },
  // Sign in with Google (OAuth 2.0 / OpenID Connect). Free: create a Web client in Google Cloud Console.
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
  },
  // Public origin used for OAuth redirects, e.g. https://lawyerup-sewl.onrender.com (falls back to the request host).
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  video: {
    provider: env.VIDEO_PROVIDER || 'jitsi',                    // jitsi | none
    jitsiBaseUrl: env.JITSI_BASE_URL || 'https://meet.jit.si',
  },
};
