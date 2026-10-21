import { geoblockResponseSchema, type GeoblockStatus } from '@pes/shared';
import { fetchJson, type HttpOptions } from './http.ts';

export const DEFAULT_GEOBLOCK_URL = 'https://polymarket.com/api/geoblock';

/**
 * Official eligibility check (https://docs.polymarket.com/developers/CLOB/geoblock).
 * The answer describes the caller's egress, i.e. the Worker's, never a user's. The project never
 * routes around it: when blocked or unknown, trading stays impossible and the reason is displayed.
 */
export async function checkGeoblock(url: string = DEFAULT_GEOBLOCK_URL, http: HttpOptions = {}, now: Date = new Date()): Promise<GeoblockStatus> {
  try {
    const res = await fetchJson(url, geoblockResponseSchema, { retries: 1, ...http });
    return {
      blocked: res.blocked,
      country: res.country ?? null,
      region: res.region ?? null,
      checkedAt: now.toISOString(),
      eligibility: res.blocked ? 'blocked' : 'allowed',
    };
  } catch {
    return { blocked: true, country: null, region: null, checkedAt: now.toISOString(), eligibility: 'unknown' };
  }
}
