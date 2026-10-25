/** Server-only by convention, like serverApi. Without the shared purge secret
 * public reads stay uncached, so hiding/removing content cannot leave a long
 * lived rendered copy behind an unconfigured invalidation integration. */
export const COMMUNITY_CACHE_TAG = "community";
export const COMMUNITY_REVALIDATE_SEC = 300;
export const communityCacheConfigured = () => !!process.env.COMMUNITY_REVALIDATE_SECRET?.trim();

export function communityCacheOptions(slug?: string, opponent = false) {
  // Best-effort purge can fail even when configured. An opponent render must
  // reach authoritative floor/removal admission on every request.
  if (opponent) return { revalidateSec: 0, tags: [] };
  const configured = communityCacheConfigured();
  const tags = [COMMUNITY_CACHE_TAG];
  if (slug && /^[A-Za-z0-9_-]{1,100}$/.test(slug)) tags.push(`community-build:${slug}`);
  return { revalidateSec: configured ? COMMUNITY_REVALIDATE_SEC : 0,
    tags: configured ? tags : [] };
}
