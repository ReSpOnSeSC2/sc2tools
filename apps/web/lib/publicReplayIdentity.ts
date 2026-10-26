import { cache } from "react";
import { getJsonWithStatus } from "@/lib/serverApi";
import { PublicFetchError } from "@/lib/publicFetchError";
import type { ReplayLibraryResponse } from "@/components/analyzer/replays/types";

export const readPublicReplayIdentity = cache(async (handle: string) => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([getJsonWithStatus<ReplayLibraryResponse>(`/v1/public/replays/${encodeURIComponent(handle)}?limit=1&fields=profile`, { revalidateSec: 0, signal: controller.signal }),
      new Promise<{ data: null; status: null }>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ data: null, status: null }); }, 8000); })]);
    if (!result.data?.profile && result.status !== 404) throw new PublicFetchError(result.status);
    return result;
  } finally { clearTimeout(timer); }
});
