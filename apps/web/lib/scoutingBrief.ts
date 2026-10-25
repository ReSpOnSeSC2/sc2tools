import { buildGrudgeLine } from "./grudge";
import { buildMatchupGrid, chronological, currentAndBestStreak, decidedOnly, gameOutcome, totalsOf } from "./h2hSeries";
import { fmtDay } from "./format";
import type { ScoutingBriefProfile } from "./dossierTypes";

const count = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const label = (value: string) => value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
const percent = (wins: number, total: number) => `${Math.round(wins / total * 100)}%`;

function mapLine(profile: ScoutingBriefProfile) {
  const rows = Object.entries(profile.byMap ?? {}).map(([name, row]) => ({ name: label(name), wins: count(row.wins), n: count(row.wins) + count(row.losses) })).filter(row => row.name && row.n > 0);
  rows.sort((a, b) => b.wins / b.n - a.wins / a.n || b.n - a.n || a.name.localeCompare(b.name));
  if (!rows.length) return null;
  const best = rows[0], worst = rows.at(-1)!;
  const describe = (row: typeof best) => `${row.name} ${percent(row.wins, row.n)} (n=${row.n})`;
  return rows.length > 1 ? `Maps in this view: best ${describe(best)}; toughest ${describe(worst)}.` : `Map in this view: ${describe(best)}.`;
}

function openerLine(profile: ScoutingBriefProfile) {
  const prediction = [...(profile.predictedStrategies ?? [])].filter(row => label(row.strategy) && Number.isFinite(row.probability) && row.probability >= 0 && row.probability <= 1).sort((a, b) => b.probability - a.probability || a.strategy.localeCompare(b.strategy))[0];
  if (!prediction) return null;
  const row = profile.byStrategy?.[prediction.strategy], n = row ? count(row.wins) + count(row.losses) : 0;
  // Predictions can ignore date bounds; never borrow a different cohort's count.
  return n ? `Likely opener from recent history: ${label(prediction.strategy)}; observed in ${n} decided games in this view.` : null;
}

function bestBuildLine(profile: ScoutingBriefProfile) {
  const cells = [...buildMatchupGrid(chronological((profile.games ?? []).slice(0, 1000)), 1000, 1000).cells.values()].filter(cell => cell.total >= 2);
  cells.sort((a, b) => b.winRate - a.winRate || b.total - a.total || a.myBuild.localeCompare(b.myBuild) || a.oppStrategy.localeCompare(b.oppStrategy));
  const best = cells[0];
  return best ? `Best recorded pairing: ${label(best.myBuild)} vs ${label(best.oppStrategy)}, ${best.wins}–${best.losses} (${percent(best.wins, best.total)}, n=${best.total})${profile.gamesTruncated ? "; latest analyzed games" : " in this view"}.` : null;
}

/** Pure six-line brief. A missing phase or unsupported observation stays absent. */
export function buildScoutingBrief(profile: ScoutingBriefProfile): string[] {
  const games = (profile.games ?? []).slice(0, 1000), totals = profile.totals ?? totalsOf(games);
  const wins = count(totals.wins), losses = count(totals.losses), streak = currentAndBestStreak(games).current;
  const lower = profile.gamesTruncated && streak?.count === decidedOnly(games).length ? "≥" : "";
  const lines = [`Last met ${fmtDay(profile.series?.lastSeen ?? profile.lastSeen)} · This view: ${wins}W–${losses}L${streak ? ` · Recent recorded streak ${streak.result}${lower}${streak.count}` : ""}.`];
  const phase = Object.entries(profile.phases?.finalPhaseDistribution ?? {}).filter(([, n]) => Number.isFinite(n) && n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const phases: Record<string, string> = { early: "early", earlyMid: "early/mid", mid: "mid", midLate: "mid/late", late: "late" };
  const latest = games[0], outcome = latest ? gameOutcome(latest) : "U";
  const grudge = buildGrudgeLine({ opponentId: profile.pulseId, opponentName: profile.name, headToHead: { wins, losses }, lastResult: outcome === "U" ? null : outcome === "W" ? "win" : "loss", lastMap: latest?.map, lastOppBuild: latest?.opp_strategy });
  for (const line of [openerLine(profile), bestBuildLine(profile), mapLine(profile), phase && phases[phase[0]] ? `Usual recorded end phase: ${phases[phase[0]]} (n=${count(phase[1])}).` : null, grudge ? `In this view: ${grudge.line}` : null]) if (line) lines.push(line);
  return lines.slice(0, 6);
}
