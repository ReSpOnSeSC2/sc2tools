import { getJson } from "@/lib/serverApi";
import { normalizeSupporterWall, type SupporterWallData } from "@/lib/supporterWall";

/** Server components: the public wall, read without a cache so removals take effect immediately. */
export async function getSupporterWall(): Promise<SupporterWallData | null> {
  return normalizeSupporterWall(await getJson<unknown>("/v1/public/supporters"));
}
