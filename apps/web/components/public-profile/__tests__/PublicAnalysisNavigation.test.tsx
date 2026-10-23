import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicReplayAnalysis } from "../PublicReplayAnalysis";
import { parseArchiveFrom, sharedAnalysisHref } from "../archiveQuery";
import type { PublicReplayDetailResponse } from "@/components/analyzer/replays/types";

const h = vi.hoisted(() => ({ push: vi.fn(), timeline: vi.fn(), mechanics: vi.fn(), observers: [] as Array<(entries: IntersectionObserverEntry[]) => void>, scroll: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: { success: vi.fn() } }) }));
vi.mock("../PublicReplayDownloadButton", () => ({ PublicReplayDownloadButton: () => <button>Download shared replay</button> }));
vi.mock("@/components/analyzer/game/InteractiveTimeline", () => ({ InteractiveTimeline: (props: Record<string, unknown>) => { h.timeline(props); return <div data-testid="interactive-timeline"><input aria-label="Scrub timeline" type="range" /><button>Timeline chart</button></div>; } }));
vi.mock("@/components/analyzer/game/MechanicsPanel", () => ({ MechanicsPanel: (props: Record<string, unknown>) => { h.mechanics(props); return <p>Mechanics</p>; } }));
vi.mock("@/components/analyzer/game/BuildOrderColumns", () => ({ BuildOrderColumns: () => <p>Both build orders content</p> }));

const root = "/players/player/replays";
const data: PublicReplayDetailResponse = {
  profile: { handle: "player", displayName: "Player" }, game: { gameId: "current/id", myRace: "Protoss", opponent: { displayName: "Rival", race: "Zerg" }, map: "Alcyone LE", result: "Victory", macroScore: 79, durationSec: 900 },
  neighbors: { olderGameId: "older/id", newerGameId: "newer/id" },
  macroBreakdown: { ok: true, stats_events: [{ time: 0 }], all_leaks: [
    { name: "Small float", penalty: 3, time: 120, mineral_cost: 600 }, { name: "Big float", penalty: 9, time: 402, mineral_cost: 300 },
    { name: "Supply block", penalty: 7, time: 300, mineral_cost: 200 }, { name: "Tiny delay", penalty: 1, time: 600, mineral_cost: 100 }, { name: "Worker gap", penalty: 5, time: 180, mineral_cost: 40 },
  ] },
  streams: [{ platform: "twitch", perspective: "me", playerName: "Player", url: "https://www.twitch.tv/videos/1234", offsetSec: 60 }, { platform: "youtube", perspective: "opponent", playerName: "Rival", url: "https://www.youtube.com/watch?v=abc", offsetSec: 80 }],
};
beforeEach(() => {
  h.push.mockReset(); h.timeline.mockReset(); h.mechanics.mockReset(); h.scroll.mockReset(); h.observers = [];
  vi.stubGlobal("IntersectionObserver", class { constructor(callback: IntersectionObserverCallback) { h.observers.push((entries) => callback(entries, this as unknown as IntersectionObserver)); } observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: h.scroll });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });

it.each(["//evil.com", "javascript:alert(1)", "https://evil.com/?result=win", "/archive?result=win", "garbage", `search=${"x".repeat(513)}`])("rejects a non-query or oversized return destination: %s", (from) => {
  expect(parseArchiveFrom(from)).toBeUndefined(); render(<PublicReplayAnalysis data={data} from={from} />);
  expect(screen.getByRole("link", { name: "Back to Player's replays" }).getAttribute("href")).toBe(root); expect(screen.getByRole("link", { name: "Older game" }).getAttribute("href")).toBe(`${root}/older%2Fid`);
});

it("keeps allowed filters/page context on Back and both neighbor links", () => {
  const from = "matchup=PvZ&result=loss&map=Alcyone&range=7d&search=Blink&build=Glaive&cursor=old&page=3&ignored=secret"; const safe = parseArchiveFrom(from)!;
  render(<PublicReplayAnalysis data={data} from={from} />);
  const back = screen.getByRole("link", { name: "Back to PvZ · Losses · “Blink” · Map: Alcyone · Last 7 days · Build: Glaive · page 3" });
  expect(back.getAttribute("href")).toBe(`${root}?${safe}`); expect(safe).not.toContain("ignored"); expect(screen.getByRole("link", { name: "Older game" }).getAttribute("href")).toBe(sharedAnalysisHref(root, "older/id", safe));
  expect(screen.getByRole("link", { name: "Newer game" }).getAttribute("href")).toBe(sharedAnalysisHref(root, "newer/id", safe));
});

it("uses non-links for list ends and hides controls when no filtered neighbor exists", () => {
  const view = render(<PublicReplayAnalysis data={{ ...data, neighbors: { olderGameId: null, newerGameId: "next" } }} />);
  expect(screen.queryByRole("link", { name: "Older game" })).toBeNull(); expect(screen.getByTitle("This is the oldest game in this list").getAttribute("aria-disabled")).toBe("true");
  view.rerender(<PublicReplayAnalysis data={{ ...data, neighbors: { olderGameId: null, newerGameId: null } }} />); expect(screen.queryByRole("navigation", { name: "Neighboring replays" })).toBeNull();
});

it("uses plain arrows outside editing and timeline controls, preserving modified browser shortcuts", () => {
  const from = "result=loss"; render(<PublicReplayAnalysis data={data} from={from} />);
  fireEvent.keyDown(document.body, { key: "ArrowLeft" }); expect(h.push).toHaveBeenLastCalledWith(sharedAnalysisHref(root, "older/id", from));
  fireEvent.keyDown(document.body, { key: "ArrowRight" }); expect(h.push).toHaveBeenLastCalledWith(sharedAnalysisHref(root, "newer/id", from)); h.push.mockClear();
  for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) fireEvent.keyDown(document.body, { key: "ArrowLeft", [modifier]: true });
  const controls = render(<div><input aria-label="Search" /><textarea aria-label="Notes" /><select aria-label="Choice"><option>Choice</option></select><div contentEditable aria-label="Editor" /><div role="slider" aria-label="Position" aria-valuenow={0} /></div>);
  for (const label of ["Search", "Notes", "Choice", "Editor", "Position", "Scrub timeline"]) fireEvent.keyDown(screen.getByLabelText(label), { key: "ArrowRight" });
  fireEvent.keyDown(screen.getByRole("button", { name: "Timeline chart" }), { key: "ArrowRight" }); expect(h.push).not.toHaveBeenCalled(); controls.unmount();
});

it("deduplicates stream chips and uses the shared bar's scroll-spy without changing guide defaults", () => {
  const view = render(<PublicReplayAnalysis data={data} />); const nav = screen.getByRole("navigation", { name: "On this page" });
  expect(within(nav).getByRole("link", { name: "Timeline" }).getAttribute("aria-current")).toBe("true"); expect(screen.getByRole("link", { name: "Watch POV (2)" }).getAttribute("href")).toBe("#watch");
  expect(screen.getAllByLabelText("Stream recordings of this game")).toHaveLength(1); expect(screen.getAllByRole("link", { name: /Watch .* POV on (Twitch|YouTube)/ })).toHaveLength(2);
  const macro = document.getElementById("macro-breakdown")!;
  const rect = new DOMRect(0, 120, 100, 100);
  act(() => h.observers[0]([{ target: macro, isIntersecting: true, boundingClientRect: rect, intersectionRect: rect, intersectionRatio: 1, rootBounds: null, time: 0 }])); expect(within(nav).getByRole("link", { name: "Macro" }).getAttribute("aria-current")).toBe("true");
  fireEvent.click(within(nav).getByRole("link", { name: "Build orders" })); expect(h.scroll).toHaveBeenCalledWith({ block: "start", behavior: "auto" }); expect(window.location.hash).toBe("#build-orders");
  view.rerender(<PublicReplayAnalysis data={{ ...data, streams: [] }} />); expect(within(screen.getByRole("navigation", { name: "On this page" })).queryByRole("link", { name: "Watch" })).toBeNull();
});

it("seeks the timeline from a leak and expands all leaks in penalty order with their total", () => {
  render(<PublicReplayAnalysis data={data} />); fireEvent.click(screen.getByRole("button", { name: "Jump timeline to 6:42" })); expect(h.timeline).toHaveBeenLastCalledWith(expect.objectContaining({ scrubTime: 402 }));
  const toggle = screen.getByRole("button", { name: "Show all 5 leaks" }); expect(toggle.getAttribute("aria-expanded")).toBe("false"); fireEvent.click(toggle); expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const list = document.getElementById(toggle.getAttribute("aria-controls")!)!; expect(within(list).getAllByRole("listitem").map((item) => item.querySelector("p")?.textContent)).toEqual(["Big float", "Supply block", "Worker gap", "Small float", "Tiny delay"]);
  expect(screen.getByText("≈ 1,240 minerals lost across 5 leaks")).toBeTruthy(); expect(screen.getByText("out of 100")).toBeTruthy();
});

it("keeps timestamps as plain text when timeline samples are unavailable", () => {
  render(<PublicReplayAnalysis data={{ ...data, macroBreakdown: { ...data.macroBreakdown!, stats_events: [], opp_stats_events: [] } }} />);
  expect(screen.queryByRole("button", { name: /Jump timeline/ })).toBeNull(); expect(screen.getByText("6:42")).toBeTruthy();
});

it.each([[79, "text-warning"], [80, "text-success"]] as const)("aligns header and public mechanics score bands at %s", (score, tone) => {
  render(<PublicReplayAnalysis data={{ ...data, game: { ...data.game, macroScore: score } }} />);
  expect(screen.getByText(String(score)).classList.contains(tone)).toBe(true);
  expect(h.mechanics).toHaveBeenLastCalledWith(expect.objectContaining({ macroScoreToneClassName: tone }));
});
