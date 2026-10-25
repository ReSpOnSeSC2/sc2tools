import fixtures from "./overlaySamples.json";
import type { LiveGameEnvelope, LiveGamePayload } from "@/components/overlay/types";

export const OVERLAY_SAMPLE_SCENARIOS = fixtures.scenarios;
export type OverlaySampleScenario = typeof fixtures.scenarios[number]["id"];

/** Shared pure synthetic builder; no token, network, browser storage or account state. */
export function overlaySample(widget?: string, scenario = "victory", nowMs = Date.now()): LiveGamePayload {
  const chosen = fixtures.scenarios.find(item => item.id === scenario) ?? fixtures.scenarios[1];
  const full = { ...structuredClone(fixtures.payload), ...structuredClone(chosen.patch) } as unknown as LiveGamePayload;
  full.session = { ...full.session!, sessionStartedAt: new Date(nowMs - fixtures.sessionAgeSec * 1000).toISOString() };
  const mapping = fixtures.widgetKeys as Record<string, string[]>;
  const keys = widget && Object.hasOwn(mapping, widget) ? mapping[widget] : null;
  const payload = keys ? Object.fromEntries([...fixtures.sharedKeys, ...keys].filter(key => (full as Record<string, unknown>)[key] !== undefined).map(key => [key, (full as Record<string, unknown>)[key]])) : full;
  return { ...payload, isTest: true, testNonce: `local-${scenario}-${nowMs}`, ...(widget ? { testWidget: widget } : {}) };
}

export function sampleLiveGame(scenario: string, nowMs: number): LiveGameEnvelope {
  const chosen = fixtures.scenarios.find(item => item.id === scenario) ?? fixtures.scenarios[1];
  return { type: "liveGameState", phase: chosen.phase as LiveGameEnvelope["phase"], capturedAt: nowMs / 1000, receivedAt: nowMs, synthetic: true,
    gameKey: `local-${scenario}`, displayTime: 150, user: { name: "SamplePlayer", race: "Protoss" },
    opponent: { name: fixtures.payload.oppName, race: "Zerg", profile: { mmr: fixtures.payload.oppMmr } },
    streamerHistory: overlaySample(undefined, scenario, nowMs) };
}

export function sampleStudio(nowMs: number) {
  return { highlight: { ...fixtures.demo.highlight, atMs: nowMs }, poll: { ...fixtures.demo.poll, startedAtMs: nowMs },
    goals: fixtures.demo.goals, buildProfile: fixtures.demo.buildProfile, scene: { ...fixtures.demo.scene, setAtMs: nowMs, countdownEndsAt: nowMs + 299000 },
    timer: { label: "Sample countdown", setAtMs: nowMs, endsAt: nowMs + 120000 }, updatedAt: new Date(nowMs).toISOString() };
}
