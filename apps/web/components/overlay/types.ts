// Shape of the live-payload the agent broadcasts to the overlay
// socket room. Matches `apps/agent/sc2tools_agent/replay_pipeline.py`.

export type LiveGamePayload = {
  /** Player race ("Terran", "Zerg", "Protoss", "Random"). */
  myRace?: string;
  /** Opponent race. */
  oppRace?: string;
  /** Opponent display name (battle tag without #1234 disambiguator). */
  oppName?: string;
  /** Map name. */
  map?: string;
  /** Matchup label, e.g. "PvT". */
  matchup?: string;
  /** Result of the just-finished game. */
  result?: "win" | "loss" | null;
  /** Game length in seconds. */
  durationSec?: number;
  /** Opponent MMR if known. */
  oppMmr?: number;
  /** Player MMR if known. */
  myMmr?: number;
  /** MMR delta from this game (signed). */
  mmrDelta?: number;
  /** Head-to-head record vs this opponent. */
  headToHead?: { wins: number; losses: number };
  /** Current win/loss streak. */
  streak?: { kind: "win" | "loss"; count: number };
  /** Cheese-likelihood score (0..1). */
  cheeseProbability?: number;
  /** Predicted opponent strategies. */
  predictedStrategies?: { name: string; weight: number }[];
  /** Top builds the player likes vs this matchup. */
  topBuilds?: { name: string; total: number; winRate: number }[];
  /** Best answer vs this opponent's most-likely opening. */
  bestAnswer?: { build: string; winRate: number; total: number } | null;
  /** Favorite opening this opponent has shown. */
  favOpening?: { name: string; share: number; samples: number } | null;
  /** Scouting tells. */
  scouting?: { label: string; tellAt?: number; confidence?: number }[];
  /** Session record (today). */
  session?: {
    wins: number;
    losses: number;
    games: number;
    mmrStart?: number;
    mmrCurrent?: number;
  };
  /** Player rank info. */
  rank?: { league?: string; tier?: number; mmr?: number };
  /** Meta — current ladder snapshot. */
  meta?: { matchup?: string; topBuilds?: { name: string; share: number }[] };
  /** Rivalry context. */
  rival?: {
    name?: string;
    headToHead?: { wins: number; losses: number };
    note?: string;
  };
  /** Rematch flag. */
  rematch?: { isRematch: boolean; lastResult?: "win" | "loss" } | null;
};
