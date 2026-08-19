/**
 * replayHud — derived data for the HUD and rails around the map replayer.
 *
 * Everything here is pure math over one ``MapPlayback`` payload, so the
 * panels stay dumb renderers and the hard parts unit-test. There is no
 * new API call: the build-order feed, the production queue, the army
 * composition, the supply cap and the timeline markers are all
 * reconstructed from ``units[]`` / ``buildings[]`` / ``battles[]`` /
 * ``casts[]`` / ``stats``.
 *
 * WHAT IS REAL AND WHAT IS DERIVED — read this before trusting a number:
 *
 *  - army value, workers, supply USED  → real, the ``stats`` series,
 *    linearly interpolated between its ~10 s rows.
 *  - kills / losses                    → real, ``units[].died`` priced
 *    through ``mapReplayLosses`` with its morph exclusions.
 *  - build-order feed                  → real event times
 *    (``units[].born``, ``buildings[].t``); the supply column beside
 *    each row is the interpolated stats series, so it is accurate to
 *    the cadence of that series, not to the frame.
 *  - production QUEUE                  → **DERIVED**. The payload has
 *    no production queues; a unit's ``born`` is when it FINISHED. The
 *    queue is reconstructed by subtracting the unit's known SC2 build
 *    time from its finish time (see ``BUILD_SECONDS``). The countdown
 *    shown is ``finish − t``, which is exact whatever the table says;
 *    only the moment an item ENTERS the queue depends on the table.
 *  - supply CAP (the "/ 200" half)     → **DERIVED** from live supply
 *    providers (see ``SUPPLY_PROVIDED``). Not in the payload.
 *  - upgrades                          → **NOT AVAILABLE AT ALL**. The
 *    payload carries no upgrade events. The rail renders an explicit
 *    empty state; do not invent one.
 *  - minerals / gas banked             → **NOT AVAILABLE**. Those live
 *    in the macro breakdown's ``stats_events``, which the replay
 *    endpoint does not return. The HUD takes them as an optional
 *    caller-supplied series and omits the fields when absent.
 *
 * CLOCK. Every time in the payload is REAL seconds (the sanitizer's
 * ``gameLength`` repair notes that v≤2 payloads mixed a 1.4× Blizzard
 * game-time length with real-second events). The build-time table below
 * is therefore in Legacy of the Void seconds, which are already the
 * real-time-at-Faster numbers Blizzard rebased onto in LotV — same
 * clock, no conversion. ``BUILD_TIME_CLOCK_SCALE`` is the single dial
 * if a future payload ever ships Blizzard game-time instead.
 */

import {
  isWorkerUnit,
  statsAt,
  unitAliveAt,
  unitPositionAt,
  type MapPlayback,
  type PlaybackUnit,
  type ReplayCast,
} from "./mapReplay";
import { morphConsumedIndices, unitCost } from "./mapReplayLosses";

export type ReplaySide = "me" | "opp";

/* ──────────────── formatting ──────────────── */

/** ``m:ss`` game clock — the same shape the replayer's own label uses. */
export function formatClock(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Acronyms the PascalCase splitter must not chop into letters. */
const NAME_ATOMS: ReadonlySet<string> = new Set(["SCV", "MULE", "MP"]);

/**
 * ``SpawningPool`` → ``Spawning Pool``, ``SCV`` → ``SCV``,
 * ``SiegeTankSieged`` → ``Siege Tank Sieged``. Payload names are
 * PascalCase sc2reader unit names; the rails show them to humans.
 */
export function prettyName(name: string): string {
  if (!name) return "";
  if (NAME_ATOMS.has(name)) return name;
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
}

/* ──────────────── SC2 build times ────────────────
 *
 * Legacy of the Void values, in seconds, as published on Liquipedia's
 * unit/structure pages (LotV rebased every build time onto real-time
 * seconds at Faster speed, i.e. the old Wings-of-Liberty "Normal speed"
 * number divided by 1.4 — Marine 25 → 18, Pylon 25 → 18, Nexus 100 →
 * 71, Zergling 24 → 17). Balance patches move a handful of these by a
 * second or two; nothing in the HUD depends on that precision, because
 * the countdown a queue bubble shows is the exact ``finish − t`` from
 * the payload and only the queue's ENTRY moment uses this table.
 *
 * Zerg morphs (Baneling, Ravager, Lurker, Overseer, Brood Lord) carry
 * the MORPH time, not the parent's build time — the parent already
 * finished and appears in the feed on its own.
 */
export const UNIT_BUILD_SECONDS: Readonly<Record<string, number>> = {
  // Protoss
  Probe: 12,
  Zealot: 27,
  Stalker: 30,
  Sentry: 26,
  Adept: 30,
  HighTemplar: 39,
  DarkTemplar: 39,
  Archon: 9,
  Immortal: 39,
  Colossus: 54,
  Disruptor: 36,
  Observer: 21,
  WarpPrism: 36,
  Phoenix: 25,
  VoidRay: 43,
  Oracle: 37,
  Tempest: 43,
  Carrier: 64,
  Interceptor: 9,
  Mothership: 89,
  MothershipCore: 30,
  // Terran
  SCV: 12,
  Marine: 18,
  Marauder: 21,
  Reaper: 32,
  Ghost: 29,
  Hellion: 21,
  Hellbat: 21,
  WidowMine: 21,
  SiegeTank: 32,
  Cyclone: 32,
  Thor: 43,
  VikingFighter: 30,
  Viking: 30,
  Medivac: 30,
  Liberator: 43,
  Raven: 34,
  Banshee: 43,
  Battlecruiser: 64,
  // Zerg
  Drone: 12,
  Zergling: 17,
  Queen: 36,
  Overlord: 18,
  Overseer: 12,
  OverlordTransport: 12,
  Roach: 19,
  Ravager: 9,
  Baneling: 14,
  Hydralisk: 24,
  LurkerMP: 18,
  Lurker: 18,
  Infestor: 36,
  SwarmHostMP: 29,
  SwarmHost: 29,
  Mutalisk: 24,
  Corruptor: 29,
  BroodLord: 24,
  Viper: 29,
  Ultralisk: 39,
};

export const STRUCTURE_BUILD_SECONDS: Readonly<Record<string, number>> = {
  // Protoss
  Nexus: 71,
  Pylon: 18,
  Assimilator: 21,
  Gateway: 46,
  WarpGate: 7,
  Forge: 32,
  CyberneticsCore: 36,
  PhotonCannon: 29,
  ShieldBattery: 29,
  TwilightCouncil: 36,
  RoboticsFacility: 46,
  Stargate: 43,
  TemplarArchive: 36,
  DarkShrine: 71,
  RoboticsBay: 46,
  FleetBeacon: 43,
  // Terran
  CommandCenter: 71,
  OrbitalCommand: 25,
  PlanetaryFortress: 36,
  SupplyDepot: 21,
  Refinery: 21,
  Barracks: 46,
  EngineeringBay: 25,
  Bunker: 29,
  MissileTurret: 18,
  SensorTower: 18,
  Factory: 43,
  GhostAcademy: 29,
  Starport: 36,
  Armory: 46,
  FusionCore: 46,
  BarracksTechLab: 18,
  FactoryTechLab: 18,
  StarportTechLab: 18,
  TechLab: 18,
  BarracksReactor: 36,
  FactoryReactor: 36,
  StarportReactor: 36,
  Reactor: 36,
  // Zerg
  Hatchery: 71,
  Lair: 57,
  Hive: 71,
  Extractor: 21,
  SpawningPool: 46,
  EvolutionChamber: 25,
  SpineCrawler: 36,
  SporeCrawler: 21,
  RoachWarren: 39,
  BanelingNest: 43,
  HydraliskDen: 29,
  LurkerDen: 57,
  LurkerDenMP: 57,
  InfestationPit: 36,
  Spire: 71,
  GreaterSpire: 71,
  NydusNetwork: 36,
  UltraliskCavern: 46,
  CreepTumor: 11,
};

/** Set to 1.4 if a payload ever arrives on Blizzard game-time rather
 *  than real seconds. Today's payloads are real seconds. */
export const BUILD_TIME_CLOCK_SCALE = 1;

/** The longest thing anyone builds — bounds the backward scan that
 *  finds the items in production at a given instant. */
const MAX_BUILD_SECONDS = 90;

/** Build seconds for a payload name, or null when the name is not a
 *  thing a player produces (Larva, Egg, Broodling, Locust, MULE, …). */
export function buildSeconds(name: string, kind: "unit" | "structure"): number | null {
  const table = kind === "unit" ? UNIT_BUILD_SECONDS : STRUCTURE_BUILD_SECONDS;
  const raw = table[name];
  if (raw === undefined || raw <= 0) return null;
  return raw * BUILD_TIME_CLOCK_SCALE;
}

/* ──────────────── supply ────────────────
 *
 * DERIVED. ``stats`` carries supply USED but no cap, so the cap is the
 * sum of what the side's live supply providers give. Overseers are
 * counted at 8 because morphing an Overlord does not free its supply.
 */
const SUPPLY_PROVIDED: Readonly<Record<string, number>> = {
  Pylon: 8,
  SupplyDepot: 8,
  SupplyDepotLowered: 8,
  Nexus: 15,
  CommandCenter: 15,
  CommandCenterFlying: 15,
  OrbitalCommand: 15,
  OrbitalCommandFlying: 15,
  PlanetaryFortress: 15,
  Hatchery: 6,
  Lair: 6,
  Hive: 6,
  Overlord: 8,
  Overseer: 8,
  OverlordTransport: 8,
};

export const SUPPLY_MAX = 200;

/* ──────────────── model types ──────────────── */

export interface BuildOrderEntry {
  key: string;
  owner: ReplaySide;
  kind: "unit" | "structure";
  name: string;
  /** Payload event time: ``units[].born`` / ``buildings[].t``. */
  t: number;
  /** Identical items produced together, e.g. a pair of Zerglings. */
  count: number;
  /** Interpolated ``stats`` supply-used at ``t``, rounded. */
  supply: number;
  isWorker: boolean;
}

/** One reconstructed in-flight item. ``start`` is derived, ``finish``
 *  is the payload's own event time. */
export interface ProductionItem {
  owner: ReplaySide;
  kind: "unit" | "structure";
  name: string;
  start: number;
  finish: number;
}

/** Queue bubble: N of a thing, soonest one landing in ``remaining`` s. */
export interface QueueGroup {
  name: string;
  count: number;
  remaining: number;
}

export interface CompositionRow {
  name: string;
  count: number;
}

export interface TimelineMarker {
  id: string;
  t: number;
  kind: "battle" | "cast";
  owner: ReplaySide | null;
  label: string;
  /** Screen-reader / tooltip text: ``2:35 · Harass taken: 150 minerals``. */
  title: string;
}

export interface PhaseBand {
  label: string;
  from: number;
  to: number;
}

export interface HudSide {
  armyValue: number;
  workers: number;
  supplyUsed: number;
  supplyCap: number;
  kills: number;
  lostMinerals: number;
  lostGas: number;
  minerals: number | null;
  gas: number | null;
}

/** One-shot per-payload derivation. Everything the rails need that is
 *  a pure function of the payload lives here, so the panels never
 *  recompute it on a frame or a scrub. */
export interface ReplayHudModel {
  gameLength: number;
  mapName: string;
  buildOrder: BuildOrderEntry[];
  production: Record<ReplaySide, ProductionItem[]>;
  markers: TimelineMarker[];
  phases: PhaseBand[];
  /** Step series of the derived supply cap, ``[t, cap]`` ascending. */
  supplyCap: Record<ReplaySide, Array<[number, number]>>;
  /** Cumulative real losses per side, ``[t, count, minerals, gas]``. */
  losses: Record<ReplaySide, Array<[number, number, number, number]>>;
  /** Live unit indices per side, for composition scans. */
  unitIndex: Record<ReplaySide, number[]>;
  units: readonly PlaybackUnit[];
  workerName: Record<ReplaySide, string | null>;
  opening: Record<ReplaySide, string | null>;
}

/* ──────────────── derivation ──────────────── */

/** Items produced within this window collapse into one feed row —
 *  a pair of Zerglings hatches on the same frame. */
const FEED_MERGE_SEC = 1;
/** Deaths this close in time and space count toward one battle marker. */
const BATTLE_MARKER_WINDOW_SEC = 10;
const BATTLE_MARKER_RADIUS_WORLD = 16;
/** Markers closer than this merge into one dot. */
const MARKER_MERGE_SEC = 8;
const MARKER_MAX = 160;
/** Casts worth a timeline dot. Everything else (Stim, Burrow, Blink,
 *  Chrono) fires constantly and would bury the notable moments. */
const NOTABLE_CASTS: ReadonlySet<string> = new Set([
  "PsiStorm",
  "EMP",
  "FungalGrowth",
  "NeuralParasite",
  "Nuke",
  "NukeCalldown",
  "Snipe",
  "GhostSnipe",
  "Yamato",
  "YamatoGun",
  "PurificationNova",
  "TimeWarp",
  "Abduct",
  "ParasiticBomb",
  "Blinding",
  "BlindingCloud",
  "Contaminate",
  "GravitonBeam",
  "MassRecall",
  "TacticalJump",
  "ForceField",
  "Feedback",
  "GuardianShield",
  "Revelation",
  "Corrosive",
  "CorrosiveBile",
]);

/** Structures that say nothing about a build's identity. */
const OPENING_IGNORED: ReadonlySet<string> = new Set([
  "Pylon",
  "SupplyDepot",
  "SupplyDepotLowered",
  "Assimilator",
  "Refinery",
  "Extractor",
  "CreepTumor",
  "CreepTumorQueen",
  "CreepTumorBurrowed",
  "TechLab",
  "Reactor",
  "BarracksTechLab",
  "BarracksReactor",
  "FactoryTechLab",
  "FactoryReactor",
  "StarportTechLab",
  "StarportReactor",
  "WarpGate",
]);
const OPENING_STEPS = 3;

export function deriveReplayHud(playback: MapPlayback): ReplayHudModel {
  const gameLength = Math.max(1, playback.gameLength);
  const consumed = morphConsumedIndices(
    playback.units,
    playback.buildings,
    playback.v,
  );

  /* ── build-order feed ──
   * Real event times. Units enter at ``born`` (when they finished),
   * structures at ``buildings[].t`` (when they appeared). Sorted, then
   * identical adjacent items within a second collapse to one ``×N``
   * row so a Zergling pair reads as one line. */
  const raw: Array<Omit<BuildOrderEntry, "key" | "count" | "supply">> = [];
  for (const u of playback.units) {
    if (!u.name) continue;
    raw.push({
      owner: u.owner,
      kind: "unit",
      name: u.name,
      t: u.born,
      isWorker: isWorkerUnit(u.name),
    });
  }
  for (const b of playback.buildings) {
    if (!b.name) continue;
    raw.push({
      owner: b.owner,
      kind: "structure",
      name: b.name,
      t: b.t,
      isWorker: false,
    });
  }
  raw.sort((a, b) => a.t - b.t || a.owner.localeCompare(b.owner));

  // ``statsAt`` rescans from row 0 on every call. The feed is already
  // time-sorted, so a per-side cursor that only moves forward turns
  // O(feedRows × statRows) into O(feedRows + statRows) — the difference
  // between 8 ms and 2 ms of mount cost on a maxed-out payload.
  const supplyCursor: Record<ReplaySide, number> = { me: 0, opp: 0 };
  const supplyUsedAt = (side: ReplaySide, t: number): number => {
    const rows = playback.stats[side];
    if (rows.length === 0) return 0;
    if (t <= rows[0][0]) return rows[0][3] ?? 0;
    const last = rows[rows.length - 1];
    if (t >= last[0]) return last[3] ?? 0;
    let i = supplyCursor[side];
    while (i + 1 < rows.length && rows[i + 1][0] <= t) i += 1;
    supplyCursor[side] = i;
    const a = rows[i];
    const b = rows[i + 1];
    if (!b || b[0] <= a[0]) return a[3] ?? 0;
    const f = (t - a[0]) / (b[0] - a[0]);
    return (a[3] ?? 0) + ((b[3] ?? 0) - (a[3] ?? 0)) * f;
  };

  const buildOrder: BuildOrderEntry[] = [];
  for (const item of raw) {
    const prev = buildOrder[buildOrder.length - 1];
    if (
      prev &&
      prev.owner === item.owner &&
      prev.kind === item.kind &&
      prev.name === item.name &&
      item.t - prev.t <= FEED_MERGE_SEC
    ) {
      prev.count += 1;
      continue;
    }
    // No cap here on purpose: truncating the feed would silently drop
    // the late game AND desync ``buildOrderIndexAt`` from the clock.
    // The sanitizer already bounds the payload (1200 units, 1000
    // buildings); it is the RAIL that limits how many rows it puts in
    // the DOM, by rendering only what has happened plus a short
    // lookahead.
    buildOrder.push({
      key: `${item.owner}:${item.kind}:${item.name}:${item.t.toFixed(2)}:${buildOrder.length}`,
      owner: item.owner,
      kind: item.kind,
      name: item.name,
      t: item.t,
      count: 1,
      supply: Math.round(supplyUsedAt(item.owner, item.t)),
      isWorker: item.isWorker,
    });
  }

  /* ── derived production queue ──
   * DERIVED: start = finish − known build time. A name with no build
   * time (Larva, Egg, Broodling, Locust, MULE, Interceptor) is not
   * something a player queues, so it never enters the queue. */
  const production: Record<ReplaySide, ProductionItem[]> = { me: [], opp: [] };
  for (const u of playback.units) {
    const dur = buildSeconds(u.name, "unit");
    if (dur === null) continue;
    production[u.owner].push({
      owner: u.owner,
      kind: "unit",
      name: u.name,
      start: Math.max(0, u.born - dur),
      finish: u.born,
    });
  }
  for (const b of playback.buildings) {
    const dur = buildSeconds(b.name, "structure");
    if (dur === null) continue;
    production[b.owner].push({
      owner: b.owner,
      kind: "structure",
      name: b.name,
      start: Math.max(0, b.t - dur),
      finish: b.t,
    });
  }
  production.me.sort((a, b) => a.start - b.start);
  production.opp.sort((a, b) => a.start - b.start);

  /* ── derived supply cap, as a step series ──
   * Each provider contributes from the moment it appears until it
   * dies. Collect the deltas, sort, accumulate. */
  const supplyCap: Record<ReplaySide, Array<[number, number]>> = {
    me: [],
    opp: [],
  };
  const deltas: Record<ReplaySide, Array<[number, number]>> = { me: [], opp: [] };
  for (const b of playback.buildings) {
    const give = SUPPLY_PROVIDED[b.name];
    if (!give) continue;
    deltas[b.owner].push([b.t, give]);
    if (b.died !== null) deltas[b.owner].push([b.died, -give]);
  }
  for (const u of playback.units) {
    const give = SUPPLY_PROVIDED[u.name];
    if (!give) continue;
    deltas[u.owner].push([u.born, give]);
    if (u.died !== null) deltas[u.owner].push([u.died, -give]);
  }
  for (const side of ["me", "opp"] as const) {
    deltas[side].sort((a, b) => a[0] - b[0]);
    let running = 0;
    for (const [t, d] of deltas[side]) {
      running += d;
      const last = supplyCap[side][supplyCap[side].length - 1];
      if (last && last[0] === t) last[1] = Math.min(SUPPLY_MAX, running);
      else supplyCap[side].push([t, Math.min(SUPPLY_MAX, running)]);
    }
  }

  /* ── cumulative losses (real: priced deaths, morphs excluded) ── */
  const losses: Record<ReplaySide, Array<[number, number, number, number]>> = {
    me: [],
    opp: [],
  };
  const deathRows: Record<
    ReplaySide,
    Array<{ t: number; x: number; y: number; minerals: number; gas: number }>
  > = { me: [], opp: [] };
  playback.units.forEach((u, i) => {
    if (u.died === null || consumed.has(i)) return;
    // Same gate ``computeLosses`` uses: an unpriced name (Larva, Egg,
    // Broodling, Interceptor) is not a loss, so the HUD's kill count
    // and the replayer's own loss panel agree to the unit.
    const cost = unitCost(u.name);
    if (!cost) return;
    const pos = unitPositionAt(u.wp, u.died) ?? { x: 0, y: 0 };
    deathRows[u.owner].push({
      t: u.died,
      x: pos.x,
      y: pos.y,
      minerals: cost.minerals,
      gas: cost.gas,
    });
  });
  for (const side of ["me", "opp"] as const) {
    deathRows[side].sort((a, b) => a.t - b.t);
    let n = 0;
    let m = 0;
    let g = 0;
    for (const d of deathRows[side]) {
      n += 1;
      m += d.minerals;
      g += d.gas;
      losses[side].push([d.t, n, m, g]);
    }
  }

  /* ── timeline markers ──
   * A battle marker is priced by the deaths around it, which turns a
   * bare (t, x, y) into "who lost what here". Casts are filtered to
   * the abilities that decide fights. */
  const rawMarkers: TimelineMarker[] = [];
  playback.battles.forEach((bt, i) => {
    let meM = 0;
    let meG = 0;
    let oppM = 0;
    let oppG = 0;
    for (const side of ["me", "opp"] as const) {
      // deathRows is time-sorted, so only the window around the battle
      // can contribute — 200 battles × 1300 deaths would otherwise be a
      // quarter of a million distance checks on mount.
      const rows = deathRows[side];
      let lo = 0;
      let hi = rows.length;
      const from = bt.t - BATTLE_MARKER_WINDOW_SEC;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].t < from) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < rows.length; i += 1) {
        const d = rows[i];
        if (d.t - bt.t > BATTLE_MARKER_WINDOW_SEC) break;
        if (Math.hypot(d.x - bt.x, d.y - bt.y) > BATTLE_MARKER_RADIUS_WORLD) continue;
        if (side === "me") {
          meM += d.minerals;
          meG += d.gas;
        } else {
          oppM += d.minerals;
          oppG += d.gas;
        }
      }
    }
    const mine = meM + meG;
    const theirs = oppM + oppG;
    let label = "Battle";
    let owner: ReplaySide | null = null;
    let detail = "";
    if (mine === 0 && theirs === 0) {
      label = "Skirmish";
    } else if (theirs === 0 || mine > theirs * 3) {
      label = "Harass taken";
      owner = "me";
      detail = resourceText(meM, meG);
    } else if (mine === 0 || theirs > mine * 3) {
      label = "Harass dealt";
      owner = "opp";
      detail = resourceText(oppM, oppG);
    } else {
      detail = `${resourceText(meM, meG)} lost, ${resourceText(oppM, oppG)} traded`;
    }
    rawMarkers.push({
      id: `battle-${i}`,
      t: bt.t,
      kind: "battle",
      owner,
      label,
      title: detail
        ? `${formatClock(bt.t)} · ${label}: ${detail}`
        : `${formatClock(bt.t)} · ${label}`,
    });
  });
  const casts: readonly ReplayCast[] = playback.casts ?? [];
  casts.forEach((c, i) => {
    if (!NOTABLE_CASTS.has(c.a)) return;
    const owner: ReplaySide = c.o === 1 ? "opp" : "me";
    const label = prettyName(c.a);
    rawMarkers.push({
      id: `cast-${i}`,
      t: c.t,
      kind: "cast",
      owner,
      label,
      title: `${formatClock(c.t)} · ${label} (${owner === "me" ? "you" : "opponent"})`,
    });
  });
  rawMarkers.sort((a, b) => a.t - b.t);
  const markers = mergeMarkers(rawMarkers);

  /* ── live unit index + worker name per side ── */
  const unitIndex: Record<ReplaySide, number[]> = { me: [], opp: [] };
  const workerName: Record<ReplaySide, string | null> = { me: null, opp: null };
  playback.units.forEach((u, i) => {
    unitIndex[u.owner].push(i);
    if (!workerName[u.owner] && isWorkerUnit(u.name) && u.name !== "MULE") {
      workerName[u.owner] = u.name;
    }
  });

  /* ── opening label (heuristic, clearly labelled in the UI) ── */
  const opening: Record<ReplaySide, string | null> = { me: null, opp: null };
  for (const side of ["me", "opp"] as const) {
    const steps = playback.buildings
      .filter((b) => b.owner === side && b.name && !OPENING_IGNORED.has(b.name))
      .sort((a, b) => a.t - b.t)
      .slice(0, OPENING_STEPS)
      .map((b) => prettyName(b.name));
    opening[side] = steps.length > 0 ? steps.join(" → ") : null;
  }

  return {
    gameLength,
    mapName: playback.mapName,
    buildOrder,
    production,
    markers,
    phases: phaseBands(gameLength),
    supplyCap,
    losses,
    unitIndex,
    units: playback.units,
    workerName,
    opening,
  };
}

function resourceText(minerals: number, gas: number): string {
  if (minerals > 0 && gas > 0) {
    return `${minerals} minerals, ${gas} gas`;
  }
  if (gas > 0) return `${gas} gas`;
  return `${minerals} minerals`;
}

/** Collapse markers that would land on the same few pixels of track,
 *  keeping the tab order (one focusable dot each) sane. */
function mergeMarkers(sorted: readonly TimelineMarker[]): TimelineMarker[] {
  const out: TimelineMarker[] = [];
  for (const m of sorted) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === m.kind &&
      prev.owner === m.owner &&
      m.t - prev.t <= MARKER_MERGE_SEC
    ) {
      continue;
    }
    out.push(m);
  }
  if (out.length <= MARKER_MAX) return out;
  // Still too many: keep an even spread rather than truncating the
  // late game away.
  const stride = out.length / MARKER_MAX;
  const thinned: TimelineMarker[] = [];
  for (let i = 0; i < MARKER_MAX; i += 1) thinned.push(out[Math.floor(i * stride)]);
  return thinned;
}

/* ──────────────── phases ────────────────
 *
 * A presentation convention, not payload data: SC2 commentary splits a
 * game at roughly 5 and 12 minutes. Bands are clipped to the actual
 * game length, so a 4-minute all-in shows one band.
 */
const PHASE_EDGES: ReadonlyArray<{ label: string; from: number }> = [
  { label: "OPENING", from: 0 },
  { label: "MID GAME", from: 300 },
  { label: "LATE GAME", from: 720 },
];

export function phaseBands(gameLength: number): PhaseBand[] {
  const out: PhaseBand[] = [];
  for (let i = 0; i < PHASE_EDGES.length; i += 1) {
    const from = PHASE_EDGES[i].from;
    if (from >= gameLength) break;
    const to = Math.min(gameLength, PHASE_EDGES[i + 1]?.from ?? gameLength);
    out.push({ label: PHASE_EDGES[i].label, from, to });
  }
  return out;
}

/* ──────────────── time queries ──────────────── */

/** Last index of ``rows`` whose time is ≤ t, or -1. Binary search. */
function lastIndexAtOrBefore(rows: ReadonlyArray<{ t: number }>, t: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t <= t) {
      hit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hit;
}

/** Index of the last build-order row already produced at ``t`` — the
 *  row the feed highlights and scrolls to. -1 before the first. */
export function buildOrderIndexAt(
  entries: readonly BuildOrderEntry[],
  t: number,
): number {
  return lastIndexAtOrBefore(entries, t);
}

/** Derived supply cap at ``t``. Zero before the first provider. */
export function supplyCapAt(model: ReplayHudModel, owner: ReplaySide, t: number): number {
  const rows = model.supplyCap[owner];
  let lo = 0;
  let hi = rows.length - 1;
  let cap = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= t) {
      cap = rows[mid][1];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return cap;
}

/** Cumulative real losses at ``t``. */
export function lossesAt(
  model: ReplayHudModel,
  owner: ReplaySide,
  t: number,
): { count: number; minerals: number; gas: number } {
  const rows = model.losses[owner];
  let lo = 0;
  let hi = rows.length - 1;
  let hit: [number, number, number, number] | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= t) {
      hit = rows[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hit
    ? { count: hit[1], minerals: hit[2], gas: hit[3] }
    : { count: 0, minerals: 0, gas: 0 };
}

/**
 * The DERIVED production queue at ``t``: every reconstructed item whose
 * ``[start, finish)`` window contains ``t``, grouped by name and sorted
 * by how soon it lands. See the file header for why this is a
 * reconstruction and not payload data.
 */
export function productionAt(
  model: ReplayHudModel,
  owner: ReplaySide,
  t: number,
): { units: QueueGroup[]; structures: QueueGroup[] } {
  const items = model.production[owner];
  const unitMap = new Map<string, QueueGroup>();
  const structMap = new Map<string, QueueGroup>();
  // Items are sorted by start; anything that could still be running
  // started within MAX_BUILD_SECONDS of now.
  let i = items.length - 1;
  while (i >= 0 && items[i].start > t) i -= 1;
  for (; i >= 0; i -= 1) {
    const item = items[i];
    if (item.start < t - MAX_BUILD_SECONDS) break;
    if (item.finish <= t) continue;
    const into = item.kind === "unit" ? unitMap : structMap;
    const existing = into.get(item.name);
    const remaining = item.finish - t;
    if (existing) {
      existing.count += 1;
      if (remaining < existing.remaining) existing.remaining = remaining;
    } else {
      into.set(item.name, { name: item.name, count: 1, remaining });
    }
  }
  const bySoonest = (a: QueueGroup, b: QueueGroup) => a.remaining - b.remaining;
  return {
    units: [...unitMap.values()].sort(bySoonest),
    structures: [...structMap.values()].sort(bySoonest),
  };
}

/** Army composition and worker count on the field at ``t``. Real data:
 *  a unit is on the field iff ``born ≤ t < died``. */
export function compositionAt(
  model: ReplayHudModel,
  owner: ReplaySide,
  t: number,
): { army: CompositionRow[]; armyCount: number; workers: number } {
  const counts = new Map<string, number>();
  let workers = 0;
  let armyCount = 0;
  for (const i of model.unitIndex[owner]) {
    const u = model.units[i];
    if (!unitAliveAt(u, t)) continue;
    if (isWorkerUnit(u.name)) {
      if (u.name !== "MULE") workers += 1;
      continue;
    }
    armyCount += 1;
    counts.set(u.name, (counts.get(u.name) ?? 0) + 1);
  }
  const army = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { army, armyCount, workers };
}

/** Structures standing at ``t``, grouped — the "On Field" tab's second
 *  block. Real data. */
export function structuresAt(
  playback: MapPlayback,
  owner: ReplaySide,
  t: number,
): CompositionRow[] {
  const counts = new Map<string, number>();
  for (const b of playback.buildings) {
    if (b.owner !== owner) continue;
    if (b.t > t) continue;
    if (b.died !== null && b.died <= t) continue;
    counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Optional caller-supplied banked-resource series, ``[t, minerals,
 * gas]`` rows. The replay payload has no such series (see the file
 * header); the macro breakdown's ``stats_events`` does, so a host that
 * already fetched it can hand it over and the top bar will show the
 * two extra fields. Absent → the fields are omitted, never faked.
 */
export interface BankedSeries {
  me: ReadonlyArray<readonly number[]>;
  opp: ReadonlyArray<readonly number[]>;
}

function interpolate(
  rows: ReadonlyArray<readonly number[]>,
  t: number,
  col: number,
): number | null {
  if (rows.length === 0) return null;
  if (t <= rows[0][0]) return rows[0][col] ?? null;
  const last = rows[rows.length - 1];
  if (t >= last[0]) return last[col] ?? null;
  for (let i = 0; i + 1 < rows.length; i += 1) {
    const a = rows[i];
    const b = rows[i + 1];
    if (t < a[0] || t > b[0] || b[0] <= a[0]) continue;
    const f = (t - a[0]) / (b[0] - a[0]);
    const av = a[col] ?? 0;
    const bv = b[col] ?? 0;
    return av + (bv - av) * f;
  }
  return last[col] ?? null;
}

/**
 * The whole top bar for one instant. Army value / workers / supply-used
 * are the real ``stats`` series interpolated between its ~10 s rows, so
 * the numbers move smoothly instead of stepping every ten seconds;
 * kills and losses are real priced deaths; the supply cap is derived;
 * minerals/gas are null unless the caller supplied a series.
 */
export function hudAt(
  model: ReplayHudModel,
  playback: MapPlayback,
  t: number,
  banked?: BankedSeries,
): Record<ReplaySide, HudSide> {
  const out = {} as Record<ReplaySide, HudSide>;
  for (const side of ["me", "opp"] as const) {
    const other: ReplaySide = side === "me" ? "opp" : "me";
    const s = statsAt(playback.stats[side], t);
    const mine = lossesAt(model, side, t);
    const theirs = lossesAt(model, other, t);
    // The stats worker column was all-zero before engine 1.5.3; the
    // live units are always right, so fall back to counting them.
    const workers = s.workers > 0 ? s.workers : compositionAt(model, side, t).workers;
    out[side] = {
      armyValue: s.army,
      workers,
      supplyUsed: s.supply,
      supplyCap: supplyCapAt(model, side, t),
      kills: theirs.count,
      lostMinerals: mine.minerals,
      lostGas: mine.gas,
      minerals: banked ? interpolate(banked[side], t, 1) : null,
      gas: banked ? interpolate(banked[side], t, 2) : null,
    };
  }
  return out;
}
