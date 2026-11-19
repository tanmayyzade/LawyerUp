// Sign in with Google — Authorization Code flow with PKCE, done on the server (no client-side tokens).
// https://developers.google.com/identity/openid-connect/openid-connect
import crypto from 'node:crypto';
import { config } from '../config.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const googleEnabled = () => Boolean(config.google.clientId && config.google.clientSecret);

const b64url = (buf) => buf.toString('base64url');
export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function authorizeUrl({ redirectUri, state, challenge }) {
  return `${AUTH_URL}?${new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  })}`;
}

/** Exchange the code for tokens. Swappable in tests. */
let exchange = async ({ code, redirectUri, verifier }) => {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: config.google.clientId, client_secret: config.google.clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google token exchange failed: ${json.error_description || json.error || res.status}`);
  return json;
};
export const _setExchangeForTests = (fn) => { exchange = fn; };

/**
 * Returns the verified Google identity. The ID token comes straight from Google's token endpoint over TLS,
 * which OpenID Connect allows in place of signature checks; we still validate issuer, audience and expiry.
 */
export async function identityFromCode({ code, redirectUri, verifier }) {
  const tokens = await exchange({ code, redirectUri, verifier });
  const parts = String(tokens.id_token || '').split('.');
  if (parts.length !== 3) throw new Error('Google did not return an ID token.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error('Unexpected token issuer.');
  if (claims.aud !== config.google.clientId) throw new Error('Token was issued for a different app.');
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error('Token has expired.');
  if (!claims.sub || !claims.email) throw new Error('Token is missing the account id or email.');
  return {
    sub: String(claims.sub),
    email: String(claims.email).toLowerCase(),
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: String(claims.name || claims.given_name || claims.email.split('@')[0]).slice(0, 120),
    picture: claims.picture ? String(claims.picture) : null,
  };
}
