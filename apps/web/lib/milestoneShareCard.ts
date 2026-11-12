import type { PersonalShareCard } from "@/lib/personalShareCards";
import { knownMmr } from "@/lib/sharePrivacy";

const FIXED_HEADLINES: Readonly<Partial<Record<string, string>>> = {
  "moment.new_season_peak": "New recorded season peak",
  "moment.loss_streak_broken": "Loss streak broken",
  "moment.revenge_win": "Revenge win",
  "moment.giant_killer": "Giant-killer win",
  "moment.marathon_win": "Marathon win",
};

function isRecordedMark(title: string): boolean {
  const match = /^Recorded ([1-9][0-9]{2,3}) MMR$/.exec(title);
  if (!match || match[0] !== title) return false;
  const rating = knownMmr(Number(match[1]));
  return rating !== null && (rating % 100 === 0 || rating % 250 === 0);
}

function isShareableHeadline(kind: string, title: string): boolean {
  if (kind === "moment.crossed_mmr_mark") return isRecordedMark(title);
  if (kind === "moment.win_streak") return title === "5 wins in a row" || title === "10 wins in a row";
  return Object.hasOwn(FIXED_HEADLINES, kind) && FIXED_HEADLINES[kind] === title;
}

/** Only headlines emitted by the ladder bell rules are eligible for sharing. */
export function milestoneShareCard({ kind, title }: { kind: string; title: string }): PersonalShareCard | null {
  return isShareableHeadline(kind, title)
    ? { kind: "milestone", title, subtitle: "StarCraft II 1v1 ladder milestone", stats: [] }
    : null;
}
