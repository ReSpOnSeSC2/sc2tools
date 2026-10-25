import type { CommunityAuthorProfile, CommunityBuildDetail } from "@/components/community/types";
import { getIconPath } from "@/lib/sc2-icons";
import { trimDescription } from "@/lib/seo/trimDescription";

export type PublicOgCardData = { kind: string; title: string; subtitle: string; badge?: string; stepsLabel?: string; stats: { label: string; value: string }[]; steps: { name: string; time: string; icon: string | null }[] };
const plain = (value: unknown, max: number) => trimDescription(typeof value === "string" ? value.replace(/<[^>]*>/g, "").replace(/[\p{Cc}]/gu, " ") : "", max);
const count = (value: unknown, signed = false) => typeof value === "number" && Number.isSafeInteger(value) && (signed || value >= 0) ? value.toLocaleString("en-US") : "—";
const timed = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1800;
const positive = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 200;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds) % 60).padStart(2, "0")}`;

/** Public snapshot only. Negative, zero-count and maximum constraints never
 * become claimed production steps. V3 rules take precedence over old signatures. */
export function communityBuildOg(data: CommunityBuildDetail): PublicOgCardData {
  const build = (data.build || {}) as Record<string, unknown>;
  const rules = Array.isArray(build.rules) ? build.rules as Record<string, unknown>[] : [];
  const signature = Array.isArray(build.signature) ? build.signature as Record<string, unknown>[] : [];
  const rows = rules.length ? rules.filter(row => row && ["before", "count_min", "count_exact"].includes(String(row.type)) && timed(row.time_lt) && (row.count === undefined && row.type === "before" || positive(row.count)))
    .map(row => ({ token: row.name, time: Number(row.time_lt), count: Number(row.count ?? 1) }))
    : signature.filter(row => row && timed(row.beforeSec) && positive(row.count)).map(row => ({ token: row.unit, time: Number(row.beforeSec), count: Number(row.count) }));
  const steps = rows.filter(row => typeof row.token === "string" && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(row.token)).sort((a, b) => a.time - b.time).slice(0, 5).map(row => {
    const token = String(row.token);
    const name = token.replace(/^(Build|Train|Research|Morph)(?=[A-Z])/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
    return { name: plain(`${row.count > 1 ? `${row.count}× ` : ""}${name}`, 36), time: `by ${clock(Math.ceil(row.time))}`, icon: getIconPath(token) };
  });
  const author = plain(data.authorName, 80);
  return { kind: "Community build", title: plain(data.title, 90) || "Community build",
    subtitle: author ? `By ${author}` : "Published anonymously",
    badge: plain(data.matchup, 16) || "Any matchup", stepsLabel: "Opening rule deadlines", stats: [{ label: "Net votes", value: count(data.votes, true) }], steps };
}

export function communityAuthorOg(data: CommunityAuthorProfile): PublicOgCardData {
  return { kind: "Community author", title: plain(data.displayName, 90) || "Community author", subtitle: "Player-published StarCraft II build orders",
    badge: plain(data.primaryRace, 16) || "Mixed races", stats: [{ label: "Published builds", value: count(data.totalBuilds) }, { label: "Net votes", value: count(data.totalVotes, true) }], steps: [] };
}

export function marketingOg(kind: "try" | "download"): PublicOgCardData {
  return kind === "try" ? { kind: "Replay analyzer", title: "Your replay. Your next improvement.", subtitle: "Analyze StarCraft II replays privately in your browser.", badge: "Free · no account", stats: [], steps: [] }
    : { kind: "Desktop app", title: "Every replay, ready to review.", subtitle: "Sync your StarCraft II replays to your private SC2 Tools library.", badge: "Windows 10 / 11", stats: [], steps: [] };
}
