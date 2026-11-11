import type { PolicyCondition } from "../build-studio/studioTypes";

/** Mirrors apps/api/src/services/classifierQuality.js. */
export type ClassifierAxis = "build" | "opponent";

export type ClassifierOrigins = { pregame: number; postgame: number; web: number; other: number };

export type ClassifierPair = {
  axis: ClassifierAxis;
  matchup: string;
  detected: string;
  declared: string;
  count: number;
  users: number;
  origins: ClassifierOrigins;
  lastConfirmedAt: string | null;
  engine?: string;
  engines: Array<{ engine: string; count: number }>;
};

export type ClassifierLabel = {
  axis: ClassifierAxis;
  label: string;
  agree: number;
  missed: number;
  mislabeled: number;
  users: number;
};

export type ClassifierEngine = {
  engine: string;
  checkIns: number;
  disagreements: number;
  users: number;
  trend?: Array<{ generatedAt: string; disagreements: number }>;
};

export type ClassifierConsoleResp = {
  snapshot: null | {
    generatedAt: string;
    windowStart: string;
    windowDays: number;
    kFloor: number;
    totals: { checkIns: number; disagreements: number; users: number; suppressedPairs: number; suppressedCheckIns: number; truncated: boolean };
    engines: ClassifierEngine[];
    origins: ClassifierOrigins;
    matchups: string[];
  };
  pairs?: ClassifierPair[];
  pairsTotal?: number;
  labels?: ClassifierLabel[];
  kFloor: number;
  windowDays: number;
  sampleLimit: number;
};

export type ClassifierRule = null | {
  name: string;
  description: string;
  surfaces: string[];
  implementation: string;
  releasedCriteria?: PolicyCondition[][];
  policy: null | { revision: number; enabled: boolean; mode: string; anyOf: PolicyCondition[][]; steps: Array<{ timeSeconds: number; action: string }>; description: string | null };
};

export type ClassifierSample = {
  sample: number;
  day: string | null;
  map: string | null;
  durationSec: number | null;
  gameVersion: string | null;
  engine: string;
  origin: string;
  race: string | null;
  opponentRace: string | null;
  buildLog: string[];
  buildLogAvailable: boolean;
  buildLogTruncated: boolean;
};

export type ClassifierSamplesResp = {
  pair: ClassifierPair;
  windowStart: string;
  sampleLimit: number;
  sampleSeconds: number;
  rules: { declared: ClassifierRule; detected: ClassifierRule };
  samples: ClassifierSample[];
};

export const AXIS_LABEL: Record<ClassifierAxis, string> = { build: "Player's build", opponent: "Opponent's build" };
export const ORIGIN_LABEL: Record<keyof ClassifierOrigins, string> = { pregame: "Pre-game plan", postgame: "Post-game check-in", web: "Website", other: "Other" };

/** "browser:1.6.3" → "Browser engine 1.6.3"; "agent" → "Desktop agent". */
export function engineLabel(engine: string): string {
  if (engine === "agent") return "Desktop agent";
  if (engine === "browser") return "Browser engine (version not recorded)";
  if (engine === "unknown") return "Uploader not recorded";
  if (engine.startsWith("agent:")) return `Desktop engine ${engine.slice(6)}`;
  return engine.startsWith("browser:") ? `Browser engine ${engine.slice(8)}` : engine;
}

/**
 * The engine-test fixture for one sample: recorded build-log clocks up to
 * 6:00 with the labels involved. Never carries a player, game or opponent.
 */
export function sampleFixture(pair: ClassifierPair, sample: ClassifierSample, sampleSeconds: number) {
  return {
    comment: `Classifier console sample: build-log lines recorded up to ${Math.floor(sampleSeconds / 60)}:00. The detector labelled it "${pair.detected}"; the player declared "${pair.declared}". No player identity.`,
    axis: pair.axis,
    matchup: pair.matchup,
    race: sample.race,
    opponentRace: sample.opponentRace,
    detected: pair.detected,
    declared: pair.declared,
    engine: sample.engine,
    gameVersion: sample.gameVersion,
    durationSec: sample.durationSec,
    buildLog: sample.buildLog,
  };
}
