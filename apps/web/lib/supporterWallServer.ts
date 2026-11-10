import { getJson } from "@/lib/serverApi";
import { normalizeSupporterWall, type SupporterWallData } from "@/lib/supporterWall";

/** Server components: the public wall, cached for 10 minutes (null when unavailable). */
export async function getSupporterWall(): Promise<SupporterWallData | null> {
  return normalizeSupporterWall(await getJson<unknown>("/v1/public/supporters", { revalidateSec: 600 }));
}
