import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { loadUser } from './lib/auth.js';
import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import bookingRoutes from './routes/bookings.js';
import paymentRoutes, { razorpayWebhook } from './routes/payments.js';
import { lawyer as lawyerRoutes, admin as adminRoutes } from './routes/workspace.js';
import practiceRoutes from './routes/practice.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Security headers (CSP allows Razorpay checkout and OpenStreetMap tiles/Leaflet).
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' https://checkout.razorpay.com https://unpkg.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https://*.tile.openstreetmap.org https://unpkg.com",
        "connect-src 'self' https://*.razorpay.com",
        "frame-src https://api.razorpay.com https://checkout.razorpay.com",
      ].join('; '),
    });
    if (config.isProd) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // Webhook needs the raw body for signature verification — mount before JSON parsing.
  app.post('/api/payments/webhook/razorpay', express.raw({ type: 'application/json', limit: '1mb' }), razorpayWebhook);

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // CSRF defence for cookie auth (on top of SameSite=Lax): every state-changing API call must declare
  // Content-Type: application/json, which a cross-site HTML form cannot do.
  app.use('/api', (req, _res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return next(new HttpError(415, 'Requests must be sent as JSON.', 'unsupported_media_type'));
    }
    next();
  });

  app.use('/api', loadUser);
  app.get('/api/health', (_req, res) => res.json({ ok: true, env: config.env, payments: config.payments.provider }));
  app.use('/api/auth', authRoutes);
  app.use('/api', publicRoutes);
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/lawyer', lawyerRoutes);
  app.use('/api/lawyer', practiceRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.', 'not_found')));

  // Frontend (single-page app)
  app.use(express.static(publicDir, { extensions: ['html'], maxAge: config.isProd ? '1h' : 0 }));
  app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // Errors
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Malformed JSON.', 'bad_request');
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500 && !config.isTest) console.error(err);
    res.status(status).json({
      error: {
        code: err.code && typeof err.code === 'string' && status < 500 ? err.code : (status >= 500 ? 'server_error' : 'error'),
        message: status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  });
  return app;
}
