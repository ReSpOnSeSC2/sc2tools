import type { GlobalPlayerIdentity, MergedIdentity } from "@/lib/opponentGroups";
import type { StrategyEntry } from "./StrategyTendencyChart";
import type { Prediction } from "./PredictedStrategiesList";
import type { ProfileGame } from "./Last5GamesTimeline";
import type { BuildPhasePayload, BuildTransitionsPayload } from "@/lib/serverApi";
import type { OpeningForecast } from "@/lib/openingForecast";

export type OpponentProfileResp = {
  globalIdentity?: GlobalPlayerIdentity | null;
  pulseId?: string;
  pulseCharacterId?: string | null;
  toonHandle?: string | null;
  // Distinct toon handles whose games merged into this profile.
  // The API merges by canonical SC2Pulse character id when one is
  // resolved, which surfaces pre-rebind games against a player
  // whose Battle.net rotated. Length > 1 → render the disclosure
  // chip; absent / length ≤ 1 → render nothing extra.
  mergedToonHandles?: string[] | null;
  // Per-name breakdown when the API merged every identity SC2Pulse
  // links to the same player into this profile (mergeLinked=1).
  // Newest activity first. Absent / length ≤ 1 → single-identity
  // profile, nothing extra rendered.
  mergedIdentities?: MergedIdentity[] | null;
  name?: string;
  firstSeen?: string | null;
  lastSeen?: string | null;
  series?: { games: import("@/lib/h2hSeries").H2HGame[]; firstSeen?: string | null; lastSeen?: string | null; sourceLimit: number; truncated: boolean };
  displayNameSample?: string;
  // SC2Pulse "revealed" identity behind a barcode — the pro/main name
  // the community linked on sc2pulse.nephest.com. Absent for opponents
  // who aren't revealed.
  revealedName?: string | null;
  // Last-known MMR — propagated from the most recent game's
  // ``opponent.mmr`` by ``recordGame`` / ``refreshMetadata``. The agent
  // sources this field SC2Pulse-first at upload time, falling back to
  // the in-replay value when SC2Pulse can't be reached. Null/absent
  // when no MMR has ever been recorded for this opponent.
  mmr?: number | null;
  /** Private user-authored scouting notes for this exact opponent row. */
  notes?: string;
  /** Add the notes to TTS when this opponent is detected. */
  notesReadAloud?: boolean;
  totals?: { wins: number; losses: number; total: number; winRate: number };
  byMap?: Record<string, { wins: number; losses: number }>;
  byStrategy?: Record<string, { wins: number; losses: number }>;
  topStrategies?: StrategyEntry[];
  predictedStrategies?: Prediction[];
  openingForecast?: OpeningForecast;
  alsoPlaysAs?: string[];
  mergedAccounts?: number;
  myRace?: string;
  oppRaceModal?: string;
  // Phase distribution for the "Where games end" outcome bar.
  // Computed server-side from the same date-filtered matched games
  // that drive the by-map / by-strategy panels.
  // Optional so old API builds that pre-date the wiring still render
  // the rest of the profile without a runtime error.
  phases?: BuildPhasePayload;
  transitions?: BuildTransitionsPayload;
  gamesTruncated?: boolean;
  games?: ProfileGame[];
  /**
   * The public community profile (/community/opponents/<id>) exists:
   * enough different players have faced this opponent. Absent from
   * older API builds, which hides the link.
   */
  communityAvailable?: boolean;
};

