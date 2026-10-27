import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SessionCard } from "../SessionCard";
import { build, matchup, mmrTrack, sessionSummary } from "./sessionCardFixtures";

const TIME_ZONE = "America/New_York";
const DETAIL_HREF = "/app/sessions/parent-encoded-id?scope=parent-encoded-scope";
afterEach(cleanup);

function definition(label: string): string | null | undefined {
  return screen.getByText(label).nextElementSibling?.textContent;
}

it("labels replay-end timestamps in the supplied timezone and separates observed play from end span", () => {
  render(<SessionCard session={sessionSummary()} detailHref={DETAIL_HREF} timeZone={TIME_ZONE} />);
  expect(screen.getByRole("heading", { level: 2, name: "Session · Oct 26, 2026" })).toBeTruthy();
  expect(screen.getByText("Recorded game ends")).toBeTruthy();
  const firstEnd = screen.getByText("Oct 26, 2026, 11:40 PM EDT");
  const lastEnd = screen.getByText("Oct 27, 2026, 12:15 AM EDT");
  expect(firstEnd.getAttribute("datetime")).toBe("2026-10-27T03:40:00.000Z");
  expect(lastEnd.getAttribute("datetime")).toBe("2026-10-27T04:15:00.000Z");
  expect(screen.getByText("Timezone: America/New_York")).toBeTruthy();
  expect(definition("Played time")).toBe("29 min");
  expect(definition("Replay-end span")).toBe("35 min");
  expect(screen.getByText("2 timed of 3 games · 1 missing")).toBeTruthy();
  expect(definition("Average macro")).toBe("0 / 100");
  expect(screen.getByText("1 scored of 3 games · 2 missing")).toBeTruthy();
});

it("keeps unknown results neutral and shows the decided matchup sample", () => {
  render(<SessionCard session={sessionSummary()} detailHref={DETAIL_HREF} timeZone={TIME_ZONE} />);
  expect(screen.getByText("3 games · 1 W · 1 L · 1 unknown")).toBeTruthy();
  const results = screen.getByRole("list", { name: "Latest 3 results, oldest to newest" });
  expect(within(results).getAllByRole("listitem").map(row => row.getAttribute("aria-label")))
    .toEqual(["Game 1: Win", "Game 2: Loss", "Game 3: Unknown"]);
  const records = screen.getByRole("list", { name: "Matchup records" });
  expect(within(records).getByText("PvT · 1 W · 1 L · 1 unknown")).toBeTruthy();
  expect(within(records).getByText("2 decided of 3 games")).toBeTruthy();
});

it("preserves exact account and Random queue tracks with first-to-last recorded change and legacy samples", () => {
  const other = mmrTrack({ myToonHandle: "2-S2-1-101", ladderRace: "P", start: 4000, end: 3980, delta: -20, peak: 4000, legacySamples: 0 });
  const session = sessionSummary({ games: 5, wins: 2, losses: 2, results: "WLWLU",
    durationMissingGames: 3, macroMissingGames: 4, matchups: [matchup({ games: 5, wins: 2, losses: 2 })],
    buildMissingGames: 3, mmr: [...sessionSummary().mmr, other],
    afterLoss: { wins: 1, losses: 0, decidedGames: 1, winRate: 1, lossWithoutFollowingDecision: 1 } });
  render(<SessionCard session={session} detailHref={DETAIL_HREF} timeZone={TIME_ZONE} />);
  const tracks = within(screen.getByRole("list", { name: "Account and queue-race MMR tracks" })).getAllByRole("listitem");
  expect(tracks).toHaveLength(3);
  expect(within(tracks[0]).getByText("1-S2-1-101")).toBeTruthy();
  expect(within(tracks[0]).getByText("Queue race: Protoss")).toBeTruthy();
  expect(within(tracks[0]).getByText("First recorded").nextElementSibling?.textContent).toBe("3,000");
  expect(within(tracks[0]).getByText("Last recorded").nextElementSibling?.textContent).toBe("3,020");
  expect(within(tracks[0]).getByText("Recorded change").nextElementSibling?.textContent).toBe("+20");
  expect(within(tracks[0]).getByText("1 legacy sample has no replay-source label.")).toBeTruthy();
  expect(within(tracks[1]).getByText("Queue race: Random")).toBeTruthy();
  expect(within(tracks[1]).getByText("Recorded change").nextElementSibling?.textContent).toBe("Unavailable (needs 2 samples)");
  expect(within(tracks[2]).getByText("2-S2-1-101")).toBeTruthy();
  expect(within(tracks[2]).getByText("Recorded change").nextElementSibling?.textContent).toBe("-20");
});

it("shows a single zero rating as observed data and a single game's played time with zero replay-end span", () => {
  const one = sessionSummary({ start: "2026-10-27T04:15:00.000Z", games: 1, wins: 0, losses: 0, unknown: 1, results: "U",
    playedMin: 20, durationSamples: 1, durationMissingGames: 0, macroMissingGames: 0,
    matchups: [matchup({ matchup: "?v?", games: 1, wins: 0, losses: 0, unknown: 1 })], topBuilds: [],
    longestDecidedStreak: { wins: 0, losses: 0 },
    afterLoss: { wins: 0, losses: 0, decidedGames: 0, winRate: null, lossWithoutFollowingDecision: 0 },
    mmr: [mmrTrack({ games: 1, samples: 1, missingGames: 0, legacySamples: 0, start: 0, end: 0, delta: null, peak: 0 })] });
  render(<SessionCard session={one} detailHref={DETAIL_HREF} timeZone={TIME_ZONE} />);
  expect(definition("Played time")).toBe("20 min");
  expect(definition("Replay-end span")).toBe("0 min");
  expect(definition("First recorded")).toBe("0");
  expect(definition("Last recorded")).toBe("0");
  expect(definition("Recorded change")).toBe("Unavailable (needs 2 samples)");
});

it("keeps unavailable duration, macro and MMR visible with missing and unattributed sample counts", () => {
  const missing = sessionSummary({ playedMin: null, durationSamples: 0, durationMissingGames: 3,
    avgMacro: null, macroSamples: 0, macroMissingGames: 3,
    mmr: [mmrTrack({ samples: 0, missingGames: 2, legacySamples: 0, start: null, end: null, delta: null, peak: null })],
    mmrUnattributedGames: 1, mmrUnattributedSamples: 1 });
  render(<SessionCard session={missing} detailHref={DETAIL_HREF} timeZone={TIME_ZONE} />);
  expect(definition("Played time")).toBe("Unavailable");
  expect(definition("Average macro")).toBe("Unavailable");
  expect(screen.getByText("0 timed of 3 games · 3 missing")).toBeTruthy();
  expect(screen.getByText("0 scored of 3 games · 3 missing")).toBeTruthy();
  expect(definition("First recorded")).toBe("—");
  expect(screen.getByText("0 valid recorded samples · 2 missing of 2 games.")).toBeTruthy();
  expect(screen.getByText("1 game could not be assigned to an exact account; 1 contains recorded MMR.")).toBeTruthy();
});

it("retains planned, detected and unavailable build provenance without inventing build links", () => {
  const session = sessionSummary({ topBuilds: [build({ name: "<custom>/not-a-build-id", games: 3, unknown: 1, provenanceUnavailableGames: 1 })], buildMissingGames: 0 });
  render(<SessionCard session={session} detailHref={DETAIL_HREF} timeZone={TIME_ZONE} />);
  const builds = screen.getByRole("region", { name: "Top builds" });
  expect(within(builds).getByText("<custom>/not-a-build-id")).toBeTruthy();
  expect(within(builds).getByText("1 planned · 1 detected · 1 provenance unavailable")).toBeTruthy();
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link").getAttribute("href")).toBe(DETAIL_HREF);
});

it("bounds mounted results and accounts, and exposes every omitted preview category", () => {
  const many = sessionSummary({ games: 5000, wins: 0, losses: 0, unknown: 5000, results: "U".repeat(5000),
    playedMin: null, durationSamples: 0, durationMissingGames: 5000, avgMacro: null, macroSamples: 0, macroMissingGames: 5000,
    longestDecidedStreak: { wins: 0, losses: 0 },
    afterLoss: { wins: 0, losses: 0, decidedGames: 0, winRate: null, lossWithoutFollowingDecision: 0 },
    mmr: Array.from({ length: 5000 }, (_, index) => mmrTrack({ myToonHandle: `1-S2-1-${index}`, games: 1,
      samples: 0, missingGames: 1, legacySamples: 0, start: null, end: null, delta: null, peak: null })),
    matchups: Array.from({ length: 5 }, (_, index) => matchup({ matchup: ["PvP", "PvT", "PvZ", "PvR", "Pv?"][index], games: 1000, wins: 0, losses: 0, unknown: 1000 })),
    topBuilds: Array.from({ length: 10 }, (_, index) => build({ name: `build-${index}`, games: 1, wins: 0, losses: 0, unknown: 1,
      plannedGames: 0, detectedGames: 0, provenanceUnavailableGames: 1 })), buildMissingGames: 4990 });
  render(<SessionCard session={many} detailHref={DETAIL_HREF} timeZone={TIME_ZONE} />);
  const results = screen.getByRole("list", { name: "Latest 12 results, oldest to newest" });
  expect(within(results).getAllByRole("listitem")).toHaveLength(12);
  expect(within(results).getByRole("listitem", { name: "Game 4989: Unknown" })).toBeTruthy();
  expect(within(results).getByRole("listitem", { name: "Game 5000: Unknown" })).toBeTruthy();
  expect(screen.getByText("4988 earlier results in session details.")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Account and queue-race MMR tracks" })).getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByText("Showing 3 of 5000 MMR tracks; 4997 more in session details.")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Matchup records" })).getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByText("2 more matchup records in session details.")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Build records" })).getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByText("Other named builds: 7 games in session details.")).toBeTruthy();
  expect(screen.getByText("Build label missing for 4990 games.")).toBeTruthy();
});

it("labels the latest manual anchor only in an explicit current view and exposes scope clipping", () => {
  const clipped = sessionSummary({ coverage: { left: "scope", right: "scope" } });
  const { rerender } = render(<SessionCard session={clipped} detailHref={DETAIL_HREF} timeZone={TIME_ZONE}
    currentView={{ activity: "active", manualAnchorAt: "2026-10-27T03:30:00.000Z" }} />);
  expect(screen.getByRole("heading", { level: 2, name: "This session · Oct 26, 2026" })).toBeTruthy();
  expect(screen.getByText(/Current view since manual reset:/)).toBeTruthy();
  expect(screen.getByText("Oct 26, 2026, 11:30 PM EDT").getAttribute("datetime")).toBe("2026-10-27T03:30:00.000Z");
  expect(screen.getByText("Earlier games may fall outside the selected scope.")).toBeTruthy();
  expect(screen.getByText("Later games may fall outside the selected scope.")).toBeTruthy();
  rerender(<SessionCard session={clipped} detailHref={DETAIL_HREF} timeZone={TIME_ZONE} />);
  expect(screen.getByRole("heading", { level: 2, name: "Session · Oct 26, 2026" })).toBeTruthy();
  expect(screen.queryByText(/Current view since manual reset:/)).toBeNull();
});

it("supports last-session hierarchy and a focusable native detail link using only the parent's URL", () => {
  render(<SessionCard session={sessionSummary({ active: false })} detailHref={DETAIL_HREF} timeZone={TIME_ZONE}
    headingLevel={3} currentView={{ activity: "last", manualAnchorAt: null }} />);
  expect(screen.getByRole("heading", { level: 3, name: "Last session · Oct 26, 2026" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 4, name: "Recorded MMR" })).toBeTruthy();
  expect(screen.queryByText("Open at refresh")).toBeNull();
  const link = screen.getByRole("link", { name: /View session details: Oct 26, 2026, 11:40 PM EDT to Oct 27, 2026, 12:15 AM EDT/ });
  expect(link.tagName).toBe("A");
  expect(link.getAttribute("href")).toBe(DETAIL_HREF);
  expect(link.tabIndex).toBe(0);
  link.focus();
  expect(document.activeElement).toBe(link);
  expect(screen.queryByText("opaque-session-descriptor")).toBeNull();
});

it.each([
  { start: "2026-11-01T05:30:00.000Z", end: "2026-11-01T06:30:00.000Z", first: "Nov 1, 2026, 1:30 AM EDT", last: "Nov 1, 2026, 1:30 AM EST" },
  { start: "2026-03-08T06:30:00.000Z", end: "2026-03-08T07:30:00.000Z", first: "Mar 8, 2026, 1:30 AM EST", last: "Mar 8, 2026, 3:30 AM EDT" },
])("shows DST zone labels while preserving elapsed replay-end span: $first to $last", ({ start, end, first, last }) => {
  render(<SessionCard session={sessionSummary({ start, end })} detailHref={DETAIL_HREF} timeZone={TIME_ZONE} />);
  expect(screen.getByText(first)).toBeTruthy();
  expect(screen.getByText(last)).toBeTruthy();
  expect(definition("Replay-end span")).toBe("60 min");
});

it("separates rating scopes and withholds change when format or queued race is not fully identified", () => {
  const session = sessionSummary({ mmr: [mmrTrack(),
    mmrTrack({ ratingScope: "ranked-team", comparable: false, delta: null }),
    mmrTrack({ ladderRace: null, comparable: false, delta: null })] });
  render(<SessionCard session={session} detailHref={DETAIL_HREF} timeZone={TIME_ZONE} />);
  const tracks = within(screen.getByRole("list", { name: "Account and queue-race MMR tracks" })).getAllByRole("listitem");
  expect(within(tracks[0]).getByText("Recorded change").nextElementSibling?.textContent).toBe("+20");
  expect(within(tracks[1]).getByText("Rating scope: ranked · team")).toBeTruthy();
  expect(within(tracks[1]).getByText("Recorded change").nextElementSibling?.textContent).toBe("Unavailable: rating track not fully identified");
  expect(within(tracks[2]).getByText("Queue race: Unknown")).toBeTruthy();
  expect(within(tracks[2]).getByText("Recorded change").nextElementSibling?.textContent).toBe("Unavailable: rating track not fully identified");
  expect(within(tracks[2]).getByText("First recorded").nextElementSibling?.textContent).toBe("3,000");
});
