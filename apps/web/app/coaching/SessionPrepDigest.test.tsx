import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ paths: [] as Array<string | null>, data: undefined as unknown, error: undefined as unknown, mutate: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "coach-user", getToken: async () => "synthetic" }),
}));
vi.mock("@/lib/clientApi", async (original) => ({
  ...await original<typeof import("@/lib/clientApi")>(),
  useApi: (path: string | null) => { api.paths.push(path); return { data: path ? api.data : undefined, error: path ? api.error : undefined, mutate: api.mutate }; },
}));

import { SessionPrepDigest } from "./SessionPrepDigest";
import { parsePrepDigest } from "./coachingPrepDigest";

function ready(role: "coach" | "student") {
  return {
    bookingId: "next", role, state: "ready",
    window: { since: "2026-10-10T19:00:00.000Z", until: "2026-10-20T12:00:00.000Z", basis: "last_session" },
    lastSession: { startAt: "2026-10-10T18:00:00.000Z", endAt: "2026-10-10T19:00:00.000Z" },
    totals: { games: 7, wins: 4, losses: 3, other: 0 },
    matchups: [{ matchup: "PvZ", games: 6, wins: 4, losses: 2, winRate: 0.667 }, { matchup: "PvT", games: 1, wins: 0, losses: 1, winRate: null }],
    unknownRaceGames: 0,
    builds: [{ name: "Blink Stalkers", games: 5 }], moreBuilds: 0, unclassifiedGames: 1,
    replays: [{ ...(role === "student" ? { gameId: "game/1" } : {}), playedAt: "2026-10-16T12:00:00.000Z", map: "Ghost River LE", matchup: "PvT", result: "Loss", build: "Blink Stalkers" }],
    moreReplays: 6, minSample: 5, lookbackDays: 90,
  };
}

function open() {
  const details = screen.getByText("Since last session").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  return details;
}

beforeEach(() => { api.paths = []; api.data = undefined; api.error = undefined; api.mutate.mockReset(); });
afterEach(cleanup);

describe("session prep digest", () => {
  it("reads nothing until opened, then shows facts with rates only above the sample floor", () => {
    api.data = ready("coach");
    render(<SessionPrepDigest bookingId="next" viewerRole="coach" timeZone="UTC" studentName="Alex" />);
    expect(api.paths.every((path) => path === null)).toBe(true);
    const details = open();
    expect(api.paths.at(-1)).toBe("/v1/coaching/calendar/bookings/next/digest");
    expect(details.textContent).toContain("Since your last session together on Oct 10 · 7 ranked 1v1 games · 4–3");
    const matchups = within(details).getByRole("region", { name: "Record by matchup" });
    expect(matchups.textContent).toContain("PvZ · 6 · 4–2 (67%)");
    expect(matchups.textContent).toContain("PvT · 1 · 0–1");
    expect(matchups.textContent).not.toContain("0–1 (");
    expect(within(details).getByRole("region", { name: "Builds played" }).textContent).toContain("Not classified · 1");
    expect(within(details).getByText("+6 older games in this window.")).toBeTruthy();
    // A coach sees the facts; the game page is the student's own.
    expect(within(details).queryByRole("link", { name: /Open game/ })).toBeNull();
    expect(within(details).getByRole("link", { name: "Find assigned replays in Practice" }).getAttribute("href")).toBe("/coaching?view=practice");
  });

  it("opens the exact coach evidence using an opaque body reference and no owner link", async () => {
    const source = ready("coach");
    const reference = "A".repeat(43);
    api.data = { ...source, replays: [{ ...source.replays[0], evidenceRef: reference, gameId: "private-game" }] };
    const blob = new Blob(["MPQ!"]);
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-length": "4" }), blob: async () => blob })
      .mockResolvedValue({ ok: false, headers: new Headers() });
    const makeUrl = vi.fn(() => "blob:synthetic-replay");
    const revokeUrl = vi.fn();
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: makeUrl, revokeObjectURL: revokeUrl }));
    vi.stubGlobal("fetch", fetch);
    const saved: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
    try {
      render(<SessionPrepDigest bookingId="next" viewerRole="coach" timeZone="UTC" defaultOpen />);
      const action = screen.getByRole("button", { name: "Download assigned replay: Ghost River LE · PvT · Blink Stalkers" });
      fireEvent.click(action);
      await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/coaching\/calendar\/bookings\/next\/digest\/replay$/), expect.objectContaining({
        method: "POST", cache: "no-store", redirect: "error", body: JSON.stringify({ reference }),
        headers: { authorization: "Bearer synthetic", "Content-Type": "application/json" },
      })));
      await waitFor(() => expect(saved).toEqual(["sc2tools-replay.SC2Replay"]));
      expect(makeUrl).toHaveBeenCalledWith(blob);
      fireEvent.click(action);
      expect((await screen.findByRole("alert")).textContent).toContain("This assigned replay could not be downloaded");
      expect(saved).toHaveLength(1);
      expect(screen.queryByRole("link", { name: /Open game/ })).toBeNull();
      expect(document.body.innerHTML).not.toContain("private-game");
    } finally { click.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("pauses the default-open digest while Sessions is hidden", () => {
    api.data = ready("coach");
    const view = render(<SessionPrepDigest bookingId="next" viewerRole="coach" timeZone="UTC" defaultOpen active={false} />);
    expect(api.paths.every((path) => path === null)).toBe(true);
    expect(screen.queryByRole("region", { name: "New replays" })).toBeNull();
    view.rerender(<SessionPrepDigest bookingId="next" viewerRole="coach" timeZone="UTC" defaultOpen active />);
    expect(api.paths.at(-1)).toBe("/v1/coaching/calendar/bookings/next/digest");
    expect(screen.getByRole("region", { name: "New replays" })).toBeTruthy();
  });

  it("links the student's own new replays to their game pages", () => {
    api.data = ready("student");
    render(<SessionPrepDigest bookingId="next" viewerRole="student" timeZone="UTC" defaultOpen />);
    const link = screen.getByRole("link", { name: "Open game: Ghost River LE · PvT · Blink Stalkers" });
    expect(link.getAttribute("href")).toBe("/app/game/game%2F1");
    expect(screen.getByText("Since your last session on Oct 10 · 7 eligible 1v1 games · 4–3")).toBeTruthy();
  });

  it("explains the consent gate to each side without any game facts", () => {
    api.data = { bookingId: "next", role: "coach", state: "sharing_off", sharing: "pending" };
    const view = render(<SessionPrepDigest bookingId="next" viewerRole="coach" timeZone="UTC" studentName="Alex" defaultOpen />);
    expect(screen.getByText(/Alex hasn't allowed practice sharing, so their games stay private/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "New replays" })).toBeNull();
    view.unmount();
    api.data = { bookingId: "next", role: "student", state: "sharing_off", sharing: "revoked" };
    render(<SessionPrepDigest bookingId="next" viewerRole="student" timeZone="UTC" defaultOpen />);
    expect(screen.getByText(/Allow practice sharing on the Practice tab/)).toBeTruthy();
  });

  it("states an empty window and retries a failed read", () => {
    api.data = { ...ready("coach"), state: "no_games", totals: { games: 0, wins: 0, losses: 0, other: 0 }, matchups: [], builds: [], unclassifiedGames: 0, replays: [], moreReplays: 0,
      window: { since: "2026-10-14T00:00:00.000Z", until: "2026-10-20T12:00:00.000Z", basis: "sharing_started" } };
    const view = render(<SessionPrepDigest bookingId="next" viewerRole="coach" timeZone="UTC" defaultOpen />);
    expect(screen.getByText("Since practice sharing started on Oct 14 · 0 ranked 1v1 games")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "New replays" })).toBeNull();
    view.unmount();
    api.data = undefined; api.error = { status: 500, message: "down" };
    render(<SessionPrepDigest bookingId="next" viewerRole="coach" timeZone="UTC" defaultOpen />);
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    expect(api.mutate).toHaveBeenCalled();
  });

  it("treats anything but the digest's own shape as unavailable", () => {
    expect(parsePrepDigest({ role: "coach", bookings: [] })).toBeNull();
    const coach = ready("coach");
    const student = ready("student");
    const bad = parsePrepDigest({ ...coach, replays: [{ ...coach.replays[0], evidenceRef: "/app/game/private", gameId: "private" }] });
    const own = parsePrepDigest({ ...student, replays: [{ ...student.replays[0], evidenceRef: "A".repeat(43) }] });
    expect(JSON.stringify(bad)).not.toMatch(/private|evidenceRef|gameId/);
    expect(JSON.stringify(own)).not.toContain("evidenceRef");
    expect(parsePrepDigest({ ...ready("coach"), state: "graded" })).toBeNull();
    expect(parsePrepDigest({ ...ready("coach"), window: { since: "x", basis: "whenever" } })).toBeNull();
  });
});
