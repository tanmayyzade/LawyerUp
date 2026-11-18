import { config } from '../config.js';

export function priceBreakdown(feePaise) {
  const platform = Math.round((feePaise * config.platformFeeBps) / 10_000);
  return { fee_paise: feePaise, platform_fee_paise: platform, total_paise: feePaise + platform };
}
