/**
 * TEST FIXTURES ONLY — contract-shaped `/v1/guides/*` payloads for the
 * guide lib and page tests. Numbers are hand-picked but internally
 * consistent (Wilson CIs, floors, catalog names and slugs); nothing here
 * may be imported by app code.
 */
export {
  FIXTURE_BASELINE_AT,
  FIXTURE_COMPUTED_AT,
  FIXTURE_FIRST_PUBLISHED_AT,
  FIXTURE_PATCH,
  fixtureCell,
} from "@/lib/guides/__fixtures__/cells";
export {
  FIXTURE_BUILD_PUBLISHED,
  FIXTURE_BUILD_UNPUBLISHED,
  FIXTURE_PVZ_MILESTONES,
} from "@/lib/guides/__fixtures__/build";
export {
  FIXTURE_COUNTER_PUBLISHED,
  FIXTURE_COUNTER_UNPUBLISHED,
  FIXTURE_MAP,
  FIXTURE_MAP_UNPUBLISHED,
  FIXTURE_ME,
  FIXTURE_SITEMAP,
} from "@/lib/guides/__fixtures__/counterMap";
export { FIXTURE_INDEX } from "@/lib/guides/__fixtures__/hub";
export { FIXTURE_MATCHUP, FIXTURE_MATCHUP_BAND } from "@/lib/guides/__fixtures__/matchup";
export {
  FIXTURE_CHANNEL,
  FIXTURE_PLAYLISTS,
  asEightWorkerPatch,
  VIDEO_PVT_STARGATE_CHARGE,
  VIDEO_PVZ_CARRIER_RUSH,
  VIDEO_PVZ_CRACKING_8_POOLS,
  VIDEO_PVZ_STARGATE_GLAIVES,
} from "@/lib/guides/__fixtures__/videos";
