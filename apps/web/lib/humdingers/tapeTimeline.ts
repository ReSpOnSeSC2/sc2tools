/**
 * Reads a Humdingers run tape (ADR 0113) for the admin replay page: the
 * timeline of what happened, the stretches with no button pressed, and how
 * long the player spent on each goal. Pure functions over decoded chunks
 * (the game's chunk format 1: docs/api/tape.md in the game).
 */
import type { TapeChunk } from "./tapeSync";

export const TICKS_PER_SECOND = 60;
/** A stretch this long without a button press is marked idle (one minute). */
export const IDLE_TICKS = 60 * TICKS_PER_SECOND;

export type TapeEventKind = "start" | "map" | "fight" | "won" | "lost" | "ran" | "level" | "save" | "load" | "quest" | "goal"
  | "gameover" | "menu" | "hint" | "world" | "screen";
export type TapeEvent = { tick: number; kind: TapeEventKind; label: string };
export type Span = { from: number; to: number };

const HINT_STEPS = ["A nudge", "More help", "Tell me exactly"];
const SCREENS: Record<string, { kind: TapeEventKind; label: string }> = {
  gameover: { kind: "gameover", label: "Game over" },
  pause: { kind: "menu", label: "Opened the menu" },
  hints: { kind: "hint", label: "Opened Hints" },
  townmap: { kind: "screen", label: "Opened the town map" },
  shop: { kind: "screen", label: "Opened a shop" },
  options: { kind: "screen", label: "Opened Options" },
  title: { kind: "screen", label: "Title screen" },
};

/** Ticks as "m:ss", or "h:mm:ss" from an hour. */
export function clock(ticks: number): string {
  const total = Math.max(0, Math.floor(ticks / TICKS_PER_SECOND));
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return hours ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function named(value: unknown): string {
  const name = text(value).replace(/_/g, " ").trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "someone";
}

/** One raw timeline entry -> a readable event, or null for an entry this page does not know. */
export function describe(entry: unknown): TapeEvent | null {
  if (!Array.isArray(entry) || typeof entry[0] !== "number" || typeof entry[1] !== "string") return null;
  const [tick, type, a, b] = entry as [number, string, unknown, unknown];
  switch (type) {
    case "new": return { tick, kind: "start", label: "Started a new game" };
    case "map": return { tick, kind: "map", label: `Entered ${text(b) || text(a)}` };
    case "fight": return { tick, kind: "fight", label: `${b ? "Boss fight" : "Fight"}: ${text(a) || "unknown foes"}` };
    case "end":
      if (a === "win") return { tick, kind: "won", label: b ? "Won the boss fight" : "Won the fight" };
      if (a === "lose") return { tick, kind: "lost", label: b ? "Lost the boss fight" : "Lost the fight" };
      if (a === "run") return { tick, kind: "ran", label: "Ran from the fight" };
      return { tick, kind: "fight", label: "The fight ended" };
    case "lvl": return { tick, kind: "level", label: `${named(a)} reached level ${text(b)}` };
    case "save": return { tick, kind: "save", label: a === "auto" ? "Autosaved" : `Saved in slot ${text(a)}` };
    case "load": return { tick, kind: "load", label: a === "auto" ? "Loaded the autosave" : `Loaded slot ${text(a)}` };
    case "quest": {
      const name = text(b) || "a quest";
      if (a === "start") return { tick, kind: "quest", label: `Quest started: ${name}` };
      if (a === "done") return { tick, kind: "quest", label: `Quest done: ${name}` };
      return { tick, kind: "quest", label: `Quest moved on: ${name}` };
    }
    case "goal": return text(a) ? { tick, kind: "goal", label: `New goal: ${text(a)}` } : null;
    case "scene": return SCREENS[text(a)] ? { tick, ...SCREENS[text(a)] } : null;
    case "hint": return { tick, kind: "hint", label: `Read a hint: ${HINT_STEPS[Number(a) - 1] ?? "a step"}` };
    case "world": return { tick, kind: "world", label: `Arrived in ${text(a)}` };
    default: return null;
  }
}

/** Every known timeline entry of the tape, in order. */
export function tapeEvents(chunks: TapeChunk[]): TapeEvent[] {
  const out: TapeEvent[] = [];
  for (const chunk of chunks) {
    for (const entry of Array.isArray(chunk.ev) ? chunk.ev : []) {
      const event = describe(entry);
      if (event) out.push(event);
    }
  }
  return out.sort((a, b) => a.tick - b.tick);
}

/** The ticks on which any button changed (from the chunks' `inp` streams). */
export function inputTicks(chunks: TapeChunk[]): number[] {
  const out: number[] = [];
  for (const chunk of chunks) {
    const inp = Array.isArray(chunk.inp) ? (chunk.inp as unknown[]) : [];
    let tick = chunk.from, at = 0;
    while (at + 1 < inp.length) {
      const dt = inp[at], count = inp[at + 1];
      if (typeof dt !== "number" || typeof count !== "number" || count < 1) break;
      tick += dt;
      out.push(tick);
      at += 2 + count;
    }
  }
  return out.sort((a, b) => a - b);
}

/** Stretches of at least IDLE_TICKS with no button pressed, up to `end`. */
export function idleSpans(chunks: TapeChunk[], end: number): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const tick of [...inputTicks(chunks), end]) {
    if (tick - last >= IDLE_TICKS) spans.push({ from: last, to: tick });
    last = Math.max(last, tick);
  }
  return spans;
}

/** How long each goal stood, longest first (the goal from its event to the next one, or to `end`). */
export function goalTimes(events: TapeEvent[], end: number): Array<{ goal: string; ticks: number }> {
  const goals = events.filter((event) => event.kind === "goal");
  const totals = new Map<string, number>();
  goals.forEach((event, index) => {
    const until = index + 1 < goals.length ? goals[index + 1].tick : end;
    const goal = event.label.replace(/^New goal: /, "");
    totals.set(goal, (totals.get(goal) ?? 0) + Math.max(0, until - event.tick));
  });
  return [...totals].map(([goal, ticks]) => ({ goal, ticks })).sort((a, b) => b.ticks - a.ticks);
}
