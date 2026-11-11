import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { BuildEditorModalProps } from "@/components/builds/editor";
import type {
  BuildOption,
  BuildOptionsResponse,
  GameIntentState,
  OpponentIntentState,
} from "@/lib/buildIntent";

/**
 * The queue's batch and undo tools: "Confirm all suggested", Undo of a
 * decision or an opponent change, the "Pick build…" / "Confirm <name>"
 * labels, normalised result badges, linked build names and the chip's
 * 44px hit area.
 */

type Entry = { data?: unknown; error?: unknown };

const harness = vi.hoisted(() => ({
  responses: {} as Record<string, Entry>,
  mutate: vi.fn(),
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "token"),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  listeners: new Set<() => void>(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken, isLoaded: true, isSignedIn: true, userId: "synthetic-owner" }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("@/components/builds/editor", () => ({
  BuildEditorModal: (props: BuildEditorModalProps) =>
    props.open ? <div role="dialog" aria-label="Build editor" /> : null,
}));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: () => undefined }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => ({ toast: harness.toast }) }));
vi.mock("@/lib/clientApi", async () => {
  const React = await import("react");
  const { useOwnerRequestScope } = await vi.importActual<typeof import("@/lib/clientApi")>("@/lib/clientApi");
  return {
    useOwnerRequestScope,
    apiCall: (...args: unknown[]) => harness.apiCall(...args),
    useApi: (path: string | null) => {
      const [, rerender] = React.useReducer((value: number) => value + 1, 0);
      React.useEffect(() => {
        const listener = () => rerender();
        harness.listeners.add(listener);
        return () => {
          harness.listeners.delete(listener);
        };
      }, []);
      if (!path) return { data: undefined, error: undefined, isLoading: false, mutate: harness.mutate };
      const entry = harness.responses[path.split("#")[0]] ?? {};
      return {
        data: entry.data,
        error: entry.error,
        isLoading: entry.data === undefined && entry.error === undefined,
        isValidating: false,
        mutate: harness.mutate,
      };
    },
  };
});

import { BuildCheckInAlert, CHIP_HIT_AREA } from "../BuildCheckInAlert";
import { BuildCheckInProvider } from "../BuildCheckInProvider";

const CHIP_PATH = "/v1/build-intents/pending?limit=1";
const QUEUE_PATH = "/v1/build-intents/pending?limit=25";
const OPP_OPTIONS_PATH = "/v1/build-intents/options?matchup=PvZ&side=opponent";
const PHOENIX = "PvZ - 2 Stargate Phoenix";
const PHOENIX_KEY = "pvz-2-stargate-phoenix";

function suggestion(key = PHOENIX_KEY, name = PHOENIX): GameIntentState["suggestion"] {
  return { key, name, slug: key.startsWith("custom:") ? key.slice(7) : null, source: key.startsWith("custom:") ? "custom" : "catalog", reason: "usual", passedRules: null, ruleCount: null };
}

function item(gameId: string, overrides: Partial<GameIntentState> = {}): GameIntentState {
  return {
    gameId,
    matchup: "PvZ",
    myRace: "Protoss",
    oppRace: "Zerg",
    result: "Defeat",
    date: new Date(Date.now() - 2 * 3600_000).toISOString(),
    durationSec: 605,
    map: "Ephemeron",
    oppName: "Foe",
    eligible: true,
    ineligibleReason: null,
    status: "pending",
    applied: false,
    build: null,
    suggestion: suggestion(),
    randomizer: null,
    randomizerDeviated: false,
    detected: { name: "PvZ - Macro Transition (Unclassified)", slug: null, key: null },
    executed: false,
    notes: "",
    origin: null,
    via: null,
    confirmedAt: null,
    updatedAt: null,
    prefs: { enabled: true, askAtLoading: true, askAfterGame: true },
    ...overrides,
  };
}

function confirmed(entry: GameIntentState): GameIntentState {
  const pick = entry.suggestion!;
  return { ...entry, status: "confirmed", applied: true, build: { key: pick.key, name: pick.name, slug: pick.slug, source: pick.source } };
}

function option(key: string, name: string): BuildOption {
  return { key, name, slug: null, source: "catalog", games: 0, wins: 0, losses: 0, checkins: 0, lastPlayedAt: null, inRandomizer: false, group: "all" };
}

function setup(items: GameIntentState[]) {
  harness.responses[CHIP_PATH] = { data: { items: [], total: items.length, disabled: false } };
  harness.responses[QUEUE_PATH] = { data: { items, total: items.length, disabled: false } };
  render(
    <BuildCheckInProvider>
      <BuildCheckInAlert compact />
    </BuildCheckInProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Build check-ins \(/ }));
  return screen.getByRole("dialog", { name: "Build check-ins" });
}

/** Each PUT answers with that game's confirmed state. */
function confirmEachGame(byId: Record<string, GameIntentState>) {
  harness.apiCall.mockImplementation(async (_token: unknown, path: string) => {
    const gameId = decodeURIComponent(path.split("/")[3]);
    return confirmed(byId[gameId]);
  });
}

const gameOf = (call: unknown[]) => decodeURIComponent(String(call[1]).split("/")[3]);
const bodyOf = (call: unknown[]) => JSON.parse((call[2] as { body: string }).body);
const entryFor = (dialog: HTMLElement, index: number) => within(dialog).getAllByTestId("build-checkin-queue-item")[index];

function startConfirmAll(dialog: HTMLElement, count: number) {
  fireEvent.click(within(dialog).getByRole("button", { name: `Confirm all suggested (${count})` }));
  const ask = within(dialog).getByRole("group", { name: "Confirm all suggested" });
  expect(ask.textContent).toContain(`Confirm ${count} suggested builds?`);
  fireEvent.click(within(ask).getByRole("button", { name: "Confirm" }));
}

afterEach(() => {
  cleanup();
  harness.responses = {};
  harness.mutate.mockReset();
  harness.apiCall.mockReset();
  harness.toast.success.mockReset();
  harness.toast.error.mockReset();
});

describe("Confirm all suggested", () => {
  it("confirms each suggestion in list order with per-game results and leaves the rest alone", async () => {
    const games = [item("g1"), item("g2", { suggestion: null }), item("g3", { suggestion: suggestion("custom:dt", "DT Rush") }), item("g4")];
    confirmEachGame(Object.fromEntries(games.map((game) => [game.gameId, game])));
    const dialog = setup(games);
    expect(within(dialog).queryByRole("button", { name: /Confirm all suggested \(1\)/ })).toBeNull();
    startConfirmAll(dialog, 3);

    await waitFor(() => expect(within(dialog).getByTestId("confirm-all-summary").textContent).toBe("Confirmed 3 of 3."));
    expect(harness.apiCall.mock.calls.map(gameOf)).toEqual(["g1", "g3", "g4"]);
    expect(harness.apiCall.mock.calls.map(bodyOf)).toEqual([
      { action: "confirm", buildKey: PHOENIX_KEY },
      { action: "confirm", buildKey: "custom:dt" },
      { action: "confirm", buildKey: PHOENIX_KEY },
    ]);
    expect(entryFor(dialog, 0).textContent).toContain(`Counted toward ${PHOENIX}`);
    expect(entryFor(dialog, 2).textContent).toContain("Counted toward DT Rush");
    expect(within(entryFor(dialog, 3)).getByRole("button", { name: "Undo" })).toBeTruthy();
    // No suggestion: untouched, still waiting for a pick.
    expect(within(entryFor(dialog, 1)).getByRole("button", { name: "Pick build…" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /Confirm all suggested/ })).toBeNull();
  });

  it.each([
    [401, "unauthenticated", "Paused: your sign-in expired. Sign in again, then retry."],
    [429, "rate_limited", "Paused: too many check-in changes at once. Wait a moment, then retry."],
  ])("stops on %i and retries the remainder", async (status, code, paused) => {
    const games = [item("g1"), item("g2"), item("g3")];
    const byId = Object.fromEntries(games.map((game) => [game.gameId, game]));
    harness.apiCall
      .mockResolvedValueOnce(confirmed(byId.g1))
      .mockRejectedValueOnce({ status, code, message: code });
    const dialog = setup(games);
    startConfirmAll(dialog, 3);

    const summary = within(dialog).getByTestId("confirm-all-summary");
    await waitFor(() => expect(summary.textContent).toContain(paused));
    expect(harness.apiCall).toHaveBeenCalledTimes(2);
    expect(entryFor(dialog, 1).textContent).not.toContain("Counted toward");

    confirmEachGame(byId);
    fireEvent.click(within(summary).getByRole("button", { name: "Retry remaining (2)" }));
    await waitFor(() => expect(summary.textContent).toBe("Confirmed 2 of 2."));
    expect(harness.apiCall.mock.calls.map(gameOf)).toEqual(["g1", "g2", "g2", "g3"]);
  });

  it("retries only the still-pending suggestions admitted in the original order", async () => {
    const games = [item("g1"), item("g2"), item("g3"), item("g4")];
    harness.apiCall
      .mockResolvedValueOnce(confirmed(games[0]))
      .mockRejectedValueOnce({ status: 429, code: "rate_limited" });
    const dialog = setup(games);
    startConfirmAll(dialog, 4);

    const summary = within(dialog).getByTestId("confirm-all-summary");
    await within(summary).findByRole("button", { name: "Retry remaining (3)" });
    const changed = item("g3", { suggestion: suggestion("custom:new", "New suggestion") });
    const refreshed = [item("new-game"), games[3], changed, games[1]];
    act(() => {
      harness.responses[QUEUE_PATH] = { data: { items: refreshed, total: refreshed.length, disabled: false } };
      harness.listeners.forEach((listener) => listener());
    });
    expect(within(dialog).getByRole("button", { name: "Confirm all suggested (4)" })).toBeTruthy();
    confirmEachGame(Object.fromEntries(refreshed.map((game) => [game.gameId, game])));

    fireEvent.click(within(summary).getByRole("button", { name: "Retry remaining (2)" }));
    await waitFor(() => expect(summary.textContent).toBe("Confirmed 2 of 2."));
    expect(harness.apiCall.mock.calls.map(gameOf)).toEqual(["g1", "g2", "g2", "g4"]);
  });

  it("reports any other failure on its game, keeps going and offers Retry", async () => {
    const games = [item("g1"), item("g2"), item("g3")];
    const byId = Object.fromEntries(games.map((game) => [game.gameId, game]));
    harness.apiCall
      .mockResolvedValueOnce(confirmed(byId.g1))
      .mockRejectedValueOnce({ status: 400, code: "unknown_build", message: "x" })
      .mockResolvedValueOnce(confirmed(byId.g3));
    const dialog = setup(games);
    startConfirmAll(dialog, 3);

    const summary = within(dialog).getByTestId("confirm-all-summary");
    await waitFor(() => expect(summary.textContent).toBe("Confirmed 2 of 3. 1 failed.Retry"));
    expect(summary.getAttribute("aria-live")).toBe("polite");
    expect(entryFor(dialog, 1).textContent).toContain("That build isn't available for this matchup any more.");

    confirmEachGame(byId);
    fireEvent.click(within(summary).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(summary.textContent).toBe("Confirmed 1 of 1."));
    expect(harness.apiCall.mock.calls.map(gameOf)).toEqual(["g1", "g2", "g3", "g2"]);
    expect(entryFor(dialog, 1).textContent).toContain(`Counted toward ${PHOENIX}`);
  });

  it("lets the write in flight finish when the queue closes, then stops", async () => {
    const games = [item("g1"), item("g2")];
    let finish: (value: GameIntentState) => void = () => {};
    harness.apiCall.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const dialog = setup(games);
    startConfirmAll(dialog, 2);
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(1));
    const init = harness.apiCall.mock.calls[0][2] as { signal?: AbortSignal };

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Build check-ins" })).toBeNull();
    expect(init.signal?.aborted ?? false).toBe(false);
    await act(async () => finish(confirmed(games[0])));
    await act(async () => {});
    expect(harness.apiCall).toHaveBeenCalledTimes(1);
  });
});

describe("Undo", () => {
  it("reopens a confirmed game and puts it back with its suggestion", async () => {
    const game = item("g1");
    harness.apiCall
      .mockResolvedValueOnce(confirmed(game))
      .mockResolvedValueOnce({ ...game, suggestion: null });
    const dialog = setup([game]);
    fireEvent.click(within(dialog).getByRole("button", { name: `Confirm ${PHOENIX}` }));
    const undo = await within(dialog).findByRole("button", { name: "Undo" });
    expect(undo.className).toContain("min-h-11");
    fireEvent.click(undo);

    const again = await within(dialog).findByRole("button", { name: `Confirm ${PHOENIX}` });
    expect(bodyOf(harness.apiCall.mock.calls[1])).toEqual({ action: "reopen" });
    expect(within(dialog).queryByRole("button", { name: "Undo" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(again));
    expect(harness.toast.success).toHaveBeenLastCalledWith("Check-in undone. The game is waiting again");
  });

  it("undoes No set build and reports a game that can no longer be reopened", async () => {
    const game = item("g1", { suggestion: null });
    harness.apiCall
      .mockResolvedValueOnce({ ...game, status: "skipped" })
      .mockRejectedValueOnce({ status: 409, code: "not_reopenable", message: "x" });
    const dialog = setup([game]);
    fireEvent.click(within(dialog).getByRole("button", { name: "No set build" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Undo" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/already undone or changed elsewhere/);
    expect(within(dialog).getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("re-sends the previous opponent build after a change from the queue's picker", async () => {
    const corrected: OpponentIntentState = {
      label: "Ling Flood",
      status: "confirmed",
      build: { key: "custom:ling-flood", name: "Ling Flood", slug: "ling-flood", source: "custom" },
      applied: true,
      detected: { name: "Zerg - 12 Pool", slug: null, key: "zerg-12-pool" },
      suggestion: null,
      executed: false,
    };
    const roach = { ...corrected, label: "Roach Rush", build: { key: "zerg-roach-rush", name: "Zerg - Roach Rush", slug: null, source: "catalog" as const } };
    const game = item("g1", { opponent: corrected });
    harness.responses[OPP_OPTIONS_PATH] = {
      data: { matchup: "PvZ", side: "opponent", randomizerEnabled: false, usualKey: null, builds: [option("zerg-12-pool", "Zerg - 12 Pool"), option("zerg-roach-rush", "Zerg - Roach Rush")] } satisfies BuildOptionsResponse,
    };
    harness.apiCall
      .mockResolvedValueOnce({ ...game, opponent: roach })
      .mockResolvedValueOnce(game);
    const dialog = setup([game]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Change the opponent's build" }));
    const listbox = within(dialog).getByRole("listbox", { name: "Opponent's build in PvZ" });
    fireEvent.click(within(listbox).getByRole("option", { name: /Roach Rush/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Zerg - Roach Rush" }));

    const undo = await within(dialog).findByRole("button", { name: "Undo the opponent's build change" });
    expect(bodyOf(harness.apiCall.mock.calls[0])).toEqual({ action: "opponent", opponentBuildKey: "zerg-roach-rush" });
    expect(entryFor(dialog, 0).textContent).toContain("Opponent's build set to Zerg - Roach Rush");
    fireEvent.click(undo);
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(2));
    expect(bodyOf(harness.apiCall.mock.calls[1])).toEqual({ action: "opponent", opponentBuildKey: "custom:ling-flood" });
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: /Undo the opponent/ })).toBeNull());
    // The game itself is still waiting for your own check-in.
    expect(within(dialog).getByRole("button", { name: `Confirm ${PHOENIX}` })).toBeTruthy();
  });
});

describe("queue labels, results and links", () => {
  it("normalises results and labels the primary action by suggestion", () => {
    const dialog = setup([
      item("g1", { result: "Victory" }),
      item("g2", { result: "defeat", suggestion: null }),
      item("g3", { result: "Tie" }),
      item("g4", { result: "abandoned" }),
    ]);
    const badges = within(dialog).getAllByTestId("build-checkin-queue-item").map((entry) => entry.querySelector("p")?.firstElementChild?.textContent);
    expect(badges).toEqual(["Win", "Loss", "Tie", "Unknown"]);
    expect(within(entryFor(dialog, 1)).getByRole("button", { name: "Pick build…" })).toBeTruthy();
    expect(within(entryFor(dialog, 0)).getByRole("button", { name: `Confirm ${PHOENIX}` })).toBeTruthy();
    expect(within(entryFor(dialog, 0)).getByRole("button", { name: "Change…" })).toBeTruthy();
  });

  it("links a suggested custom build to its page and closes the queue when it is followed", () => {
    const dialog = setup([item("g1", { suggestion: suggestion("custom:dt-rush", "DT Rush") })]);
    const link = within(dialog).getByRole("link", { name: "DT Rush" });
    expect(link.getAttribute("href")).toBe("/builds/dt-rush");
    const stopNavigation = (event: Event) => event.preventDefault();
    document.addEventListener("click", stopNavigation);
    try {
      fireEvent.click(link);
    } finally {
      document.removeEventListener("click", stopNavigation);
    }
    expect(screen.queryByRole("dialog", { name: "Build check-ins" })).toBeNull();
  });

  it("gives the 32px header chip a hit area of at least 44px", () => {
    harness.responses[CHIP_PATH] = { data: { items: [], total: 2, disabled: false } };
    render(
      <BuildCheckInProvider>
        <BuildCheckInAlert compact />
      </BuildCheckInProvider>,
    );
    const chip = screen.getByRole("button", { name: "Build check-ins (2)" });
    const classes = chip.className.split(/\s+/);
    expect(classes).toContain("h-8");
    expect(classes).toContain("relative");
    for (const token of CHIP_HIT_AREA.split(" ")) expect(classes).toContain(token);
    const inset = Number(/before:-inset-([\d.]+)/.exec(chip.className)?.[1]);
    // Tailwind spacing: 1 unit = 4px; h-8 = 32px.
    expect(32 + 2 * inset * 4).toBeGreaterThanOrEqual(44);
  });
});
