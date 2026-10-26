/** Decorated Community DTOs contain current publication capabilities.
 * An optional purge service cannot authorize reuse after profile opt-out;
 * pure content and internal aggregation caches remain separate. */
export const COMMUNITY_CACHE_TAG = "community";

export function communityCacheOptions(_slug?: string, _opponent = false) {
  return { revalidateSec: 0, tags: [] };
}
