// Shared synthetic values; clocks/nonces remain relative to each local Test.
import fixtures from "../overlaySamples.json";
import type { ChatEvent } from "./events";
import type { StudioGoal, StudioHighlight, StudioPoll, StudioScene } from "./useStudioState";
import type { SessionSummary } from "@/components/overlay/widgets/SessionWidget";
export function testHighlight(nowMs: number): StudioHighlight { return { ...fixtures.demo.highlight, atMs: nowMs } as StudioHighlight; }
export function testPoll(nowMs: number): StudioPoll { return { ...fixtures.demo.poll, options: [...fixtures.demo.poll.options], startedAtMs: nowMs } as StudioPoll; }
export const TEST_POLL_TALLY_STEPS: ReadonlyArray<{ counts: number[]; total: number }> = fixtures.demo.pollTallySteps;
export const TEST_POLL_STEP_MS = 1000;
export function testEvents(nowMs: number): ChatEvent[] { return fixtures.demo.events.map((seed, index) => ({ ...seed, id: `test-event-${nowMs}-${index}`, atMs: nowMs + index } as ChatEvent)); }
export const TEST_EVENT_INTERVAL_MS = 2000;
export const TEST_GOALS: ReadonlyArray<StudioGoal> = fixtures.demo.goals;
export function testScene(nowMs: number, mode: StudioScene["mode"] = "starting"): StudioScene { return { ...fixtures.demo.scene, mode, countdownEndsAt: nowMs + fixtures.demo.scene.countdownEndsAt, setAtMs: nowMs }; }
export function testSession(): SessionSummary { return structuredClone(fixtures.demo.fallbackSession) as SessionSummary; }
