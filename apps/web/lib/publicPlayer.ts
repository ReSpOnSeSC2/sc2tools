import { cache } from "react";
import { getJsonWithStatus } from "@/lib/serverApi";
import { PublicFetchError } from "@/lib/publicFetchError";
import type { PublicPlayerResponse } from "@/components/public-profile/types";

/** Consent is authoritative on every request. React memoization only shares
 * metadata/page work within that request; aggregate caching sits behind the API gate. */
export const fetchPublicPlayer = cache(async (player: string) => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([getJsonWithStatus<PublicPlayerResponse>(`/v1/public/players/${encodeURIComponent(player)}`,
      { revalidateSec: 0, signal: controller.signal }), new Promise<{ data: null; status: null }>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ data: null, status: null }); }, 8000);
    })]);
    return result.data && !validPublicPlayerResponse(result.data) ? { data: null, status: result.status } : result;
  } finally { clearTimeout(timer); }
});
function validPublicPlayerResponse(value: PublicPlayerResponse) {
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{10}$/;
  if (!value || !slug.test(value.handle) || typeof value.displayName !== "string" || typeof value.archiveOnly !== "boolean") return false;
  if (value.archiveOnly) return value.profile === null;
  return Boolean(value.profile && value.profile.handle === value.handle && value.profile.displayName === value.displayName
    && value.profile.totals && Number.isFinite(value.profile.totals.games)
    && Array.isArray(value.profile.matchups) && Array.isArray(value.profile.signatureBuilds));
}
export function publicPlayerPath(handle: string) { return `/players/${encodeURIComponent(handle)}`; }
export async function resolvePublicPlayer(player: string) {
  const result = await fetchPublicPlayer(player);
  if (!result.data && result.status !== 404) throw new PublicFetchError(result.status);
  return result;
}
