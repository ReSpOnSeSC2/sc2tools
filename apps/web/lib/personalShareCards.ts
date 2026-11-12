import type { SharedCardKind } from "@/lib/analytics/shareEvents";
import type { SessionSummary } from "@/lib/sessionHistory";

type ShareStat = { label: string; value: string };
export type PersonalShareCard = {
  title: string;
  subtitle: string;
  stats: readonly ShareStat[];
} & (
  { kind: Extract<SharedCardKind, "fingerprint" | "session_report">; path?: never }
  | { kind: "practice_grade"; path: `/b/${string}` }
);

type FingerprintShareFacts = {
  matchup: string;
  games: number;
  distinctBuilds: number | null;
  buildSamples: number;
  averageSeconds: number | null;
  durationSamples: number;
};

function count(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

function gameCount(value: number): string {
  return `${value} ${value === 1 ? "game" : "games"}`;
}

function minutes(value: number): string {
  return `${value.toFixed(1).replace(/\.0$/, "")} min`;
}

/** Only measured aggregates and the built-in matchup alphabet leave the page. */
export function fingerprintShareCard(facts: FingerprintShareFacts): PersonalShareCard {
  const stats: ShareStat[] = [{ label: "Games in sample", value: count(facts.games) ? String(facts.games) : "Unavailable" }];
  if (count(facts.distinctBuilds) && count(facts.buildSamples) && facts.buildSamples > 0) {
    stats.push({ label: `Builds detected in ${gameCount(facts.buildSamples)}`, value: String(facts.distinctBuilds) });
  }
  if (facts.averageSeconds !== null && Number.isFinite(facts.averageSeconds) && facts.averageSeconds >= 0
    && count(facts.durationSamples) && facts.durationSamples > 0) {
    stats.push({ label: `Average duration in ${gameCount(facts.durationSamples)}`, value: minutes(facts.averageSeconds / 60) });
  }
  return {
    kind: "fingerprint",
    title: "Skill fingerprint",
    subtitle: /^[PTZ]v[PTZ]$/.test(facts.matchup) ? `${facts.matchup} · 1v1 playstyle` : "1v1 playstyle",
    stats,
  };
}

type SessionShareFacts = Pick<SessionSummary, "games" | "wins" | "losses" | "unknown" | "playedMin" | "durationSamples">;

export function sessionReportShareCard(session: SessionShareFacts): PersonalShareCard {
  const stats: ShareStat[] = [
    { label: "Games in session", value: count(session.games) ? String(session.games) : "Unavailable" },
    { label: "Wins – losses", value: count(session.wins) && count(session.losses) ? `${session.wins} – ${session.losses}` : "Unavailable" },
    { label: "Unknown outcomes", value: count(session.unknown) ? String(session.unknown) : "Unavailable" },
  ];
  if (session.playedMin !== null && Number.isFinite(session.playedMin) && session.playedMin >= 0
    && count(session.durationSamples) && session.durationSamples > 0) {
    stats.push({ label: `Time played in ${gameCount(session.durationSamples)}`, value: minutes(session.playedMin) });
  }
  return { kind: "session_report", title: "Session report", subtitle: "Your replay results for this session", stats };
}
