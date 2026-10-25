import type { CasualtyEvent, LeakItem, StatsEvent, SupplyBlockWindow } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import { casualtyCost } from "@/components/analyzer/macro/casualtyCost";
import { canonicalizeName } from "@/components/analyzer/macro/compositionAt";
import { detectBattles } from "./gameTimeline";
import { getUnitCost } from "./sc2-units";
import type { PatchEra } from "./meta";

export type StoryLead = { time: number; armyLead: number | null; workerLead: number | null; incomeLead: number | null; combinedLead: number | null };
export type StoryTurningPoint = { start: number; time: number; delta: number; label: string };
export type StoryLoss = { minerals: number; gas: number; supply: number | null; unpriced: number; units: { name: string; count: number }[]; estimatedValue?: number };
export type StoryFight = { id: string; start: number; end: number; duration: number; me: StoryLoss; opp: StoryLoss; estimated: boolean; tradeRatio: number | null; outcome: "won" | "even" | "lost" | "unknown"; label: string };
export type StoryChip = { id: string; time: number; label: string };
export type GameStory = { leadSeries: StoryLead[]; turningPoints: StoryTurningPoint[]; fights: StoryFight[]; recap: string[]; chips: StoryChip[]; topLeak: { name: string; detail: string; time: number | null } | null; meaningful: boolean };
export type GameStoryInput = {
  gameId: string; result?: string | null;
  statsEvents?: readonly StatsEvent[] | null; oppStatsEvents?: readonly StatsEvent[] | null;
  casualtyEvents?: readonly CasualtyEvent[] | null;
  buildEvents?: readonly { time: number; name: string; category?: string }[] | null;
  patchEra?: PatchEra | null; supplyBlockedSeconds?: number | null;
  supplyBlockWindows?: readonly SupplyBlockWindow[] | null; leaks?: readonly LeakItem[] | null;
};

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const nonnegative = (n: unknown): n is number => finite(n) && n >= 0;
const clock = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
const value = (row: StatsEvent | undefined, key: keyof StatsEvent) => nonnegative(row?.[key]) ? row![key]! : null;
const income = (row: StatsEvent | undefined) => {
  const m = value(row, "minerals_collection_rate"), g = value(row, "vespene_collection_rate");
  return m === null || g === null ? null : m + g;
};
const difference = (a: number | null, b: number | null) => a === null || b === null ? null : a - b;
const relative = (a: number | null, b: number | null) => a === null || b === null ? null : (a - b) / Math.max(1, a + b);

/** Last-known paired samples; missing observations never become a zero lead. */
export function storyLeadSeries(me: readonly StatsEvent[] = [], opp: readonly StatsEvent[] = []): StoryLead[] {
  const ordered = (rows: readonly StatsEvent[]) => rows.filter(row => nonnegative(row.time)).slice().sort((a, b) => a.time - b.time);
  const left = ordered(me), right = ordered(opp);
  if (!left.length || !right.length) return [];
  const end = Math.min(left.at(-1)!.time, right.at(-1)!.time);
  const times = [...new Set([...left, ...right].map(row => row.time))].filter(t => t <= end).sort((a, b) => a - b);
  let li = -1, ri = -1;
  return times.flatMap(time => {
    while (li + 1 < left.length && left[li + 1].time <= time) li++;
    while (ri + 1 < right.length && right[ri + 1].time <= time) ri++;
    if (li < 0 || ri < 0) return [];
    const a = left[li], b = right[ri];
    if (time - a.time > 30 || time - b.time > 30) return [{ time, armyLead: null, workerLead: null, incomeLead: null, combinedLead: null }];
    const av = value(a, "army_value"), bv = value(b, "army_value"), aw = value(a, "food_workers"), bw = value(b, "food_workers"), ai = income(a), bi = income(b);
    // Require the same three channels for every composite sample. Otherwise a
    // newly available channel could create a spurious turning point.
    const channels = [relative(av, bv), relative(aw, bw), relative(ai, bi)];
    return [{ time, armyLead: difference(av, bv), workerLead: difference(aw, bw), incomeLead: difference(ai, bi), combinedLead: channels.every(finite) ? channels.reduce<number>((sum, n) => sum + n!, 0) / 3 : null }];
  });
}

function turningPoints(series: readonly StoryLead[]): StoryTurningPoint[] {
  const candidates: StoryTurningPoint[] = [];
  let before = 0;
  for (let i = 1; i < series.length; i++) {
    const end = series[i], start = end.time - 30;
    while (before + 1 < i && series[before + 1].time <= start) before++;
    const a = series[before], b = series[before + 1];
    if (start < a.time || !finite(a.combinedLead) || !finite(b.combinedLead) || !finite(end.combinedLead)) continue;
    // Interpolate only within the actual observed interval, never across a
    // missing composite or a long telemetry gap.
    if (b.time - a.time > 30 || series.slice(before, i + 1).some(row => !finite(row.combinedLead))) continue;
    const baseline = a.combinedLead + (b.combinedLead - a.combinedLead) * (start - a.time) / Math.max(1, b.time - a.time);
    const delta = (end.combinedLead - baseline) * 100;
    if (Math.abs(delta) >= 1) candidates.push({ start, time: end.time, delta, label: `Largest swing ${delta > 0 ? "toward you" : "toward your opponent"} · ${clock(end.time)}` });
  }
  const selected: StoryTurningPoint[] = [];
  for (const candidate of candidates.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.time - b.time)) {
    if (selected.every(other => candidate.start >= other.time || candidate.time <= other.start)) selected.push(candidate);
    if (selected.length === 3) break;
  }
  return selected.sort((a, b) => a.time - b.time);
}

const emptyLoss = (): StoryLoss => ({ minerals: 0, gas: 0, supply: 0, unpriced: 0, units: [] });
function outcome(me: StoryLoss, opp: StoryLoss, estimated: boolean): Pick<StoryFight, "tradeRatio" | "outcome" | "label"> {
  if (me.unpriced || opp.unpriced) return { tradeRatio: null, outcome: "unknown", label: "Trade unknown · missing prices" };
  const own = me.estimatedValue ?? me.minerals + me.gas, theirs = opp.estimatedValue ?? opp.minerals + opp.gas;
  const prefix = estimated ? "Estimated " : "";
  if (!own && !theirs) return { tradeRatio: null, outcome: "unknown", label: `${prefix}trade unknown` };
  if (!own) return { tradeRatio: null, outcome: "won", label: `${prefix}won trade · no priced losses` };
  const ratio = theirs / own;
  return { tradeRatio: ratio, outcome: ratio > 1.25 ? "won" : ratio < .8 ? "lost" : "even", label: `${prefix}${ratio > 1.25 ? `Won trade ${ratio.toFixed(1)}×` : ratio < .8 ? `Lost trade ${ratio.toFixed(1)}×` : "Even"}` };
}

/** Death clusters chain across gaps <=10s, including long fights and harass.
 * An explicit empty ledger is authoritative; only an absent ledger estimates. */
export function storyFights(input: GameStoryInput): StoryFight[] {
  if (!Array.isArray(input.casualtyEvents)) return detectBattles(input.statsEvents, input.oppStatsEvents).map((battle, i) => {
    const me = { ...emptyLoss(), estimatedValue: battle.myLoss, supply: null }, opp = { ...emptyLoss(), estimatedValue: battle.oppLoss, supply: null };
    const bothMeasured = [input.statsEvents, input.oppStatsEvents].every(rows => {
      const measured = (rows ?? []).filter(row => nonnegative(row.time) && nonnegative(row.army_value)).slice().sort((a, b) => a.time - b.time);
      const first = measured.findLastIndex(row => row.time <= battle.start), last = measured.findIndex(row => row.time >= battle.end);
      return first >= 0 && last > first && measured.slice(first + 1, last + 1).every((row, index) => row.time - measured[first + index].time <= 30);
    });
    return { id: `estimated:${i}:${battle.start}`, start: battle.start, end: battle.end, duration: battle.end - battle.start, me, opp, estimated: true, ...(bothMeasured ? outcome(me, opp, true) : { tradeRatio: null, outcome: "unknown" as const, label: "Estimated fight · one side unmeasured" }) };
  });
  const events = (input.casualtyEvents as readonly CasualtyEvent[]).filter(event => nonnegative(event.time) && (event.owner === "me" || event.owner === "opp") && ["workers", "units", "buildings"].includes(event.category) && typeof event.name === "string" && event.name.length > 0).slice().sort((a, b) => a.time - b.time || a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));
  const fights: StoryFight[] = [];
  for (const event of events) {
    let fight = fights.at(-1);
    if (!fight || event.time - fight.end > 10) {
      fight = { id: `fight:${fights.length}:${event.time}`, start: event.time, end: event.time, duration: 0, me: emptyLoss(), opp: emptyLoss(), estimated: false, tradeRatio: null, outcome: "unknown", label: "" };
      fights.push(fight);
    }
    fight.end = event.time; fight.duration = fight.end - fight.start;
    const loss = fight[event.owner], cost = casualtyCost(event.name, input.patchEra);
    if (cost) { loss.minerals += cost.minerals; loss.gas += cost.gas; } else loss.unpriced++;
    const canonical = canonicalizeName(event.name);
    const supply = event.category === "buildings" ? 0 : getUnitCost(typeof canonical === "string" ? canonical : event.name, input.patchEra)?.s;
    loss.supply = finite(supply) && loss.supply !== null ? loss.supply + supply : null;
    const unit = loss.units.find(row => row.name === event.name);
    if (unit) unit.count++; else loss.units.push({ name: event.name, count: 1 });
  }
  return fights.map(fight => ({ ...fight, me: { ...fight.me, units: fight.me.units.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 3) }, opp: { ...fight.opp, units: fight.opp.units.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 3) }, ...outcome(fight.me, fight.opp, false) }));
}

function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { value ^= text.charCodeAt(i); value = Math.imul(value, 0x01000193); }
  return value >>> 0;
}

export function gameStory(input: GameStoryInput): GameStory {
  const leadSeries = storyLeadSeries(input.statsEvents ?? [], input.oppStatsEvents ?? []);
  const fights = storyFights(input), turns = turningPoints(leadSeries), chips: StoryChip[] = [], recap: string[] = [];
  const peak = leadSeries.filter(row => finite(row.armyLead) && row.armyLead > 0).sort((a, b) => b.armyLead! - a.armyLead! || a.time - b.time)[0];
  if (peak) {
    chips.push({ id: "army-peak", time: peak.time, label: `Peak army lead +${Math.round(peak.armyLead!)} · ${clock(peak.time)}` });
    const variants = [`Your largest sampled army lead was ${Math.round(peak.armyLead!)} resources at ${clock(peak.time)}.`, `At ${clock(peak.time)}, your sampled army lead peaked at ${Math.round(peak.armyLead!)} resources.`];
    recap.push(variants[hash(input.gameId) % variants.length]);
  }
  let overtake: StoryLead | undefined;
  for (let i = 1; i < leadSeries.length; i++) if (finite(leadSeries[i - 1].workerLead) && leadSeries[i - 1].workerLead! <= 0 && finite(leadSeries[i].workerLead) && leadSeries[i].workerLead! > 0) { overtake = leadSeries[i]; break; }
  if (overtake) {
    chips.push({ id: "worker-overtake", time: overtake.time, label: `Overtook in workers · ${clock(overtake.time)}` });
    const held = leadSeries.filter(row => row.time >= overtake!.time).every(row => finite(row.workerLead) && row.workerLead > 0);
    recap.push(`You moved ahead in sampled workers at ${clock(overtake.time)}${held ? " and kept that lead through the last paired sample" : ""}.`);
  }
  if (fights.length) {
    const won = fights.filter(row => row.outcome === "won"), lost = fights.filter(row => row.outcome === "lost"), even = fights.filter(row => row.outcome === "even").length;
    chips.push({ id: "fights-won", time: won[0]?.start ?? fights[0].start, label: `${won.length} ${won.length === 1 ? "fight" : "fights"} won` });
    chips.push({ id: "fights-lost", time: lost[0]?.start ?? fights[0].start, label: `${lost.length} ${lost.length === 1 ? "fight" : "fights"} lost` });
    recap.push(`${fights.some(row => row.estimated) ? "Estimated army-drop windows" : "Recorded casualty clusters"}: ${won.length} ${won.length === 1 ? "trade" : "trades"} won, ${lost.length} lost and ${even} even${fights.some(row => row.outcome === "unknown") ? "; some trades could not be priced" : ""}.`);
  }
  if (nonnegative(input.supplyBlockedSeconds)) chips.push({ id: "supply-blocks", time: input.supplyBlockWindows?.find(row => nonnegative(row.start))?.start ?? 0, label: `${Math.round(input.supplyBlockedSeconds)}s supply blocked · ${input.supplyBlockedSeconds >= 10 ? "at/above" : "below"} 10s threshold${input.supplyBlockWindows?.length ? "" : " · whole game"}` });
  const leak = (input.leaks ?? []).filter(row => typeof row.name === "string" && (finite(row.mineral_cost) && row.mineral_cost > 0 || finite(row.penalty) && row.penalty > 0)).slice().sort((a, b) => (b.mineral_cost ?? 0) - (a.mineral_cost ?? 0) || (b.penalty ?? 0) - (a.penalty ?? 0) || a.name!.localeCompare(b.name!))[0];
  const topLeak = leak ? { name: leak.name!, detail: leak.detail || (nonnegative(leak.mineral_cost) ? `Estimated ${Math.round(leak.mineral_cost)} minerals lost under the macro rules.` : `${Math.round(leak.penalty!)} macro score points.`), time: nonnegative(leak.time) ? leak.time : null } : null;
  // Build evidence can anchor the recap without treating a start as completion.
  const opening = (input.buildEvents ?? []).filter(row => nonnegative(row.time) && row.time > 0 && row.time <= 180 && (row.category === "building" || row.category === "structure")).slice().sort((a, b) => a.time - b.time || a.name.localeCompare(b.name))[0];
  if (opening && recap.length < 4) recap.push(`The build log records ${opening.name} starting at ${clock(opening.time)}.`);
  return { leadSeries, turningPoints: turns, fights, chips, recap: recap.slice(0, 4), topLeak, meaningful: Boolean(peak || overtake || fights.length || turns.length || topLeak || nonnegative(input.supplyBlockedSeconds) && input.supplyBlockedSeconds >= 10) };
}
