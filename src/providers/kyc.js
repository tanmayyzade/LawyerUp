// Identity verification (KYC).
//
// Milestone 1 ships ONLY a sandbox provider. It never asks for, receives or stores an Aadhaar number,
// photo or document. A production integration must go through a UIDAI-licensed AUA/KUA partner or
// DigiLocker, keep any Aadhaar data in an Aadhaar Data Vault, and store only the partner's opaque reference.
import crypto from 'node:crypto';
import { config } from '../config.js';

const sandbox = {
  name: 'sandbox',
  async start(user) {
    return { reference: `sbx_${crypto.randomBytes(8).toString('hex')}`, status: 'verified', note: `Sandbox verification for ${user.name}. No ID data collected.` };
  },
};

export function kycProvider() {
  if (config.kyc.provider !== 'sandbox') {
    return { name: config.kyc.provider, async start() { throw new Error(`KYC provider "${config.kyc.provider}" is not integrated yet.`); } };
  }
  return sandbox;
}
