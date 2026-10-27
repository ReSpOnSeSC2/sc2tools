import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { BuildEditorModalProps } from "@/components/builds/editor";
import type {
  BuildOptionsResponse,
  GameIntentState,
  PendingIntentsResponse,
} from "@/lib/buildIntent";

type Entry = { data?: unknown; error?: unknown };

const harness = vi.hoisted(() => ({
  responses: {} as Record<string, Entry>,
  paths: [] as string[],
  mutate: vi.fn(),
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "token"),
  socket: null as Record<string, (payload: unknown) => void> | null,
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  pathname: "/app",
  listeners: new Set<() => void>(),
  editor: null as BuildEditorModalProps | null,
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken, isLoaded: true, isSignedIn: true, userId: "synthetic-owner" }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => harness.pathname,
}));
vi.mock("@/components/builds/editor", () => ({
  BuildEditorModal: (props: BuildEditorModalProps) => {
    harness.editor = props;
    return props.open ? (
      <div role="dialog" aria-label="Build editor">
        <button type="button" onClick={props.onClose}>
          Close editor
        </button>
      </div>
    ) : null;
  },
}));
vi.mock("@/lib/useUserSocket", () => ({
  useUserSocket: (handlers: Record<string, (payload: unknown) => void> | null) => {
    harness.socket = handlers;
  },
}));
vi.mock("@/components/ui/Toast", () => ({
  useToastOptional: () => ({ toast: harness.toast }),
}));
vi.mock("@/lib/clientApi", async () => {
  const React = await import("react");
  const { useOwnerRequestScope } = await vi.importActual<typeof import("@/lib/clientApi")>("@/lib/clientApi");
  return {
    useOwnerRequestScope,
    apiCall: (...args: unknown[]) => harness.apiCall(...args),
    useApi: (path: string | null) => {
      // Re-read the canned responses whenever a test calls `refresh()`.
      const [, rerender] = React.useReducer((value: number) => value + 1, 0);
      React.useEffect(() => {
        const listener = () => rerender();
        harness.listeners.add(listener);
        return () => {
          harness.listeners.delete(listener);
        };
      }, []);
      if (!path) return { data: undefined, error: undefined, isLoading: false, mutate: harness.mutate };
      harness.paths.push(path);
      const base = path.split("#")[0];
      const entry = harness.responses[base] ?? {};
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

import { BuildCheckInAlert } from "../BuildCheckInAlert";
import { BuildCheckInProvider } from "../BuildCheckInProvider";

const CHIP_PATH = "/v1/build-intents/pending?limit=1";
const QUEUE_PATH = "/v1/build-intents/pending?limit=25";
const OPTIONS_PATH = "/v1/build-intents/options?matchup=PvZ";

/** Re-render every mocked request with the current canned responses. */
function refresh() {
  act(() => {
    harness.listeners.forEach((listener) => listener());
  });
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
    suggestion: {
      key: "pvz-2-stargate-phoenix",
      name: "PvZ - 2 Stargate Phoenix",
      slug: null,
      source: "catalog",
      reason: "usual",
      passedRules: null,
      ruleCount: null,
    },
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

const OPTIONS: BuildOptionsResponse = {
  matchup: "PvZ",
  randomizerEnabled: false,
  usualKey: "pvz-2-stargate-phoenix",
  builds: [
    {
      key: "pvz-2-stargate-phoenix",
      name: "PvZ - 2 Stargate Phoenix",
      slug: null,
      source: "catalog",
      games: 9,
      wins: 6,
      losses: 3,
      checkins: 1,
      lastPlayedAt: null,
      inRandomizer: false,
      group: "yours",
    },
    {
      key: "custom:dt-3-gate",
      name: "DT into 3 Gate",
      slug: "dt-3-gate",
      source: "custom",
      games: 0,
      wins: 0,
      losses: 0,
      checkins: 0,
      lastPlayedAt: null,
      inRandomizer: false,
      group: "yours",
      ruleCount: 3,
    },
  ],
};

function pending(items: GameIntentState[], extra: Partial<PendingIntentsResponse> = {}) {
  return { items, total: items.length, disabled: false, ...extra };
}

function renderAlert() {
  return render(
    <BuildCheckInProvider>
      <BuildCheckInAlert compact />
    </BuildCheckInProvider>,
  );
}

function openQueue() {
  fireEvent.click(screen.getByRole("button", { name: /^Build check-ins \(/ }));
  return screen.getByRole("dialog", { name: "Build check-ins" });
}

afterEach(() => {
  cleanup();
  harness.responses = {};
  harness.paths = [];
  harness.pathname = "/app";
  harness.editor = null;
  harness.socket = null;
  harness.mutate.mockReset();
  harness.apiCall.mockReset();
  harness.toast.success.mockReset();
  harness.toast.error.mockReset();
});

describe("BuildCheckInAlert chip", () => {
  it("stays hidden while loading, at zero, and when check-ins are off", () => {
    renderAlert();
    expect(screen.queryByRole("button")).toBeNull();
    expect(harness.socket).toBeNull();
    cleanup();

    harness.responses[CHIP_PATH] = { data: pending([]) };
    renderAlert();
    expect(screen.queryByRole("button")).toBeNull();
    expect(harness.socket).not.toBeNull();
    cleanup();

    harness.responses[CHIP_PATH] = {
      data: { items: [], total: 4, disabled: true },
    };
    renderAlert();
    expect(screen.queryByRole("button")).toBeNull();
    expect(harness.socket).toBeNull();
  });

  it("shows the pending count and opens the queue dialog", () => {
    harness.responses[CHIP_PATH] = { data: { items: [], total: 3, disabled: false } };
    harness.responses[QUEUE_PATH] = { data: pending([item("g1"), item("g2"), item("g3")]) };
    renderAlert();
    const chip = screen.getByRole("button", { name: "Build check-ins (3)" });
    expect(chip.getAttribute("aria-haspopup")).toBe("dialog");
    expect(chip.textContent).toContain("3");
    expect(harness.paths).toContain(`${CHIP_PATH}#checkin-0`);

    const dialog = openQueue();
    expect(within(dialog).getAllByTestId("build-checkin-queue-item")).toHaveLength(3);
    expect(within(dialog).getAllByText("PvZ - 2 Stargate Phoenix")).toHaveLength(3);
    expect(within(dialog).getAllByText("Your usual PvZ build")).toHaveLength(3);
    expect(
      within(dialog).getAllByRole("link", { name: /Open game/ })[0].getAttribute("href"),
    ).toBe("/app/game/g1");
  });

  it("caps the count bubble at 99+", () => {
    harness.responses[CHIP_PATH] = { data: { items: [], total: 140, disabled: false } };
    renderAlert();
    expect(screen.getByRole("button", { name: "Build check-ins (140)" }).textContent).toContain(
      "99+",
    );
  });
});

describe("BuildCheckInQueue", () => {
  it("confirms the suggestion and refreshes the chip and queue", async () => {
    harness.responses[CHIP_PATH] = { data: { items: [], total: 1, disabled: false } };
    harness.responses[QUEUE_PATH] = { data: pending([item("2026|g 1")]) };
    harness.apiCall.mockResolvedValue({
      ...item("2026|g 1"),
      status: "confirmed",
      applied: true,
      build: { key: "pvz-2-stargate-phoenix", name: "PvZ - 2 Stargate Phoenix", slug: null, source: "catalog" },
    });
    renderAlert();
    const dialog = openQueue();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(within(dialog).getAllByText("Counted toward PvZ - 2 Stargate Phoenix").length).toBeGreaterThan(0),
    );
    const [, path, init] = harness.apiCall.mock.calls[0];
    expect(path).toBe("/v1/games/2026%7Cg%201/build-intent");
    expect(JSON.parse(init.body)).toEqual({ action: "confirm", buildKey: "pvz-2-stargate-phoenix" });
    expect(harness.paths).toContain(`${CHIP_PATH}#checkin-1`);
    expect(harness.paths).toContain(`${QUEUE_PATH}#checkin-1`);
  });

  it("opens the picker inline with the matchup's builds", async () => {
    harness.responses[CHIP_PATH] = { data: { items: [], total: 1, disabled: false } };
    harness.responses[QUEUE_PATH] = { data: pending([item("g1")]) };
    harness.responses[OPTIONS_PATH] = { data: OPTIONS };
    harness.apiCall.mockResolvedValue({
      ...item("g1"),
      status: "confirmed",
      applied: true,
      build: { key: "custom:dt-3-gate", name: "DT into 3 Gate", slug: "dt-3-gate", source: "custom" },
    });
    renderAlert();
    const dialog = openQueue();
    expect(harness.paths).not.toContain(OPTIONS_PATH);
    fireEvent.click(within(dialog).getByRole("button", { name: "Change…" }));
    // The revision refetches the list after any check-in write.
    expect(harness.paths).toContain(`${OPTIONS_PATH}#checkin-0`);
    const listbox = within(dialog).getByRole("listbox", { name: "Build you went for in PvZ" });
    const usual = within(listbox).getAllByRole("option")[0];
    expect(within(usual).getByText("Usual")).toBeTruthy();
    expect(usual.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(listbox).getAllByRole("option")[1]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm DT into 3 Gate" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalled());
    expect(JSON.parse(harness.apiCall.mock.calls[0][2].body)).toEqual({
      action: "confirm",
      buildKey: "custom:dt-3-gate",
    });
  });

  it("marks a game as no set build and reports failures inline", async () => {
    harness.responses[CHIP_PATH] = { data: { items: [], total: 1, disabled: false } };
    harness.responses[QUEUE_PATH] = { data: pending([item("g1", { suggestion: null })]) };
    harness.apiCall.mockRejectedValueOnce({ status: 429, code: "rate_limited", message: "x" });
    renderAlert();
    const dialog = openQueue();
    expect(within(dialog).getByText(/No suggestion yet/)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Confirm" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "No set build" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/Too many check-in changes/);
    expect(JSON.parse(harness.apiCall.mock.calls[0][2].body)).toEqual({ action: "skip" });
  });

  it("dismisses every pending game after an inline confirmation", async () => {
    harness.responses[CHIP_PATH] = { data: { items: [], total: 2, disabled: false } };
    harness.responses[QUEUE_PATH] = { data: pending([item("g1"), item("g2")]) };
    harness.apiCall.mockResolvedValue({ dismissed: 2 });
    renderAlert();
    const dialog = openQueue();
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss all" }));
    const confirm = within(dialog).getByRole("group", { name: "Confirm dismiss all" });
    expect(confirm.textContent).toContain("Mark all 2 games as no set build?");
    fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss all" }));
    await waitFor(() => expect(harness.toast.success).toHaveBeenCalledWith("Dismissed 2 check-ins"));
    expect(harness.apiCall).toHaveBeenCalledWith(harness.getToken, "/v1/build-intents/pending/dismiss", {
      method: "POST",
      body: "{}",
    });
    expect(harness.paths).toContain(`${QUEUE_PATH}#checkin-1`);
  });

  it("shows the caught-up, error and disabled states", () => {
    harness.responses[CHIP_PATH] = { data: { items: [], total: 1, disabled: false } };
    harness.responses[QUEUE_PATH] = { data: pending([]) };
    renderAlert();
    let dialog = openQueue();
    expect(within(dialog).getByText("You're all caught up")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Dismiss all" }).hasAttribute("disabled")).toBe(true);
    expect(
      within(dialog).getByRole("link", { name: "Check-in settings" }).getAttribute("href"),
    ).toBe("/settings?tab=checkin");
    cleanup();

    harness.responses[QUEUE_PATH] = { error: { status: 503, message: "Something went wrong on our side. Try again in a moment." } };
    renderAlert();
    dialog = openQueue();
    expect(within(dialog).getByRole("alert").textContent).toContain("Something went wrong");
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(harness.mutate).toHaveBeenCalled();
    cleanup();

    harness.responses[QUEUE_PATH] = { data: { items: [], total: 0, disabled: true } };
    renderAlert();
    dialog = openQueue();
    expect(within(dialog).getByText("Build check-ins are off")).toBeTruthy();
  });
});

describe("BuildCheckInQueue — navigation and focus", () => {
  it("closes when the route changes and when a game is opened", () => {
    harness.responses[CHIP_PATH] = { data: { items: [], total: 1, disabled: false } };
    harness.responses[QUEUE_PATH] = { data: pending([item("g1")]) };
    const view = renderAlert();
    openQueue();
    harness.pathname = "/app/game/g1";
    view.rerender(
      <BuildCheckInProvider>
        <BuildCheckInAlert compact />
      </BuildCheckInProvider>,
    );
    expect(screen.queryByRole("dialog", { name: "Build check-ins" })).toBeNull();

    // Same route (the game already open): the link itself closes it.
    // (jsdom can't navigate; the router would.)
    const stopNavigation = (event: Event) => event.preventDefault();
    document.addEventListener("click", stopNavigation);
    try {
      const dialog = openQueue();
      fireEvent.click(within(dialog).getByRole("link", { name: /Open game/ }));
      expect(screen.queryByRole("dialog", { name: "Build check-ins" })).toBeNull();
    } finally {
      document.removeEventListener("click", stopNavigation);
    }
  });

  it("focuses the picker once its builds load and returns focus on Cancel", () => {
    harness.responses[CHIP_PATH] = { data: { items: [], total: 1, disabled: false } };
    harness.responses[QUEUE_PATH] = { data: pending([item("g1")]) };
    renderAlert();
    const dialog = openQueue();
    const change = within(dialog).getByRole("button", { name: "Change…" });
    fireEvent.click(change);
    const combobox = within(dialog).getByRole("combobox") as HTMLInputElement;
    expect(combobox.disabled).toBe(true);

    harness.responses[OPTIONS_PATH] = { data: OPTIONS };
    refresh();
    expect(combobox.disabled).toBe(false);
    expect(document.activeElement).toBe(combobox);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Change…" }));
  });

  it("moves focus to the outcome, then keeps it in the dialog when the game leaves", async () => {
    harness.responses[CHIP_PATH] = { data: { items: [], total: 2, disabled: false } };
    harness.responses[QUEUE_PATH] = { data: pending([item("g1"), item("g2")]) };
    harness.apiCall.mockResolvedValue({
      ...item("g1"),
      status: "confirmed",
      applied: true,
      build: { key: "pvz-2-stargate-phoenix", name: "PvZ - 2 Stargate Phoenix", slug: null, source: "catalog" },
    });
    renderAlert();
    const dialog = openQueue();
    // Let the dialog place its initial focus first.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const first = within(dialog).getAllByTestId("build-checkin-queue-item")[0];
    const confirm = within(first).getByRole("button", { name: "Confirm" });
    confirm.focus();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Counted toward PvZ - 2 Stargate Phoenix"),
    );
    expect(first.contains(document.activeElement)).toBe(true);

    // The refresh drops the handled game.
    harness.responses[QUEUE_PATH] = { data: pending([item("g2")]) };
    refresh();
    expect(within(dialog).getAllByTestId("build-checkin-queue-item")).toHaveLength(1);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });

  it("asks about every pending game when the list shows only the newest", () => {
    harness.responses[CHIP_PATH] = { data: { items: [], total: 40, disabled: false } };
    harness.responses[QUEUE_PATH] = {
      data: pending(
        Array.from({ length: 25 }, (_, index) => item(`g${index}`)),
        { total: 40 },
      ),
    };
    renderAlert();
    const dialog = openQueue();
    expect(within(dialog).getByText("Showing the newest 25 of 40.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss all" }));
    expect(
      within(dialog).getByRole("group", { name: "Confirm dismiss all" }).textContent,
    ).toContain("Mark all 40 games as no set build?");
  });
});

describe("BuildCheckInQueue — opponent and Add new build", () => {
  const BUILD_ORDER_PATH = "/v1/games/g1/build-order";
  const withOpponent = (overrides: Partial<GameIntentState> = {}) =>
    item("g1", {
      opponent: {
        label: "Ling Flood",
        status: "confirmed",
        build: { key: "custom:ling-flood", name: "Ling Flood", slug: "ling-flood", source: "custom" },
        applied: true,
        detected: { name: "Zerg - 12 Pool", slug: null, key: "zerg-12-pool" },
        suggestion: null,
        executed: false,
      },
      ...overrides,
    });

  function setup(entry: GameIntentState = withOpponent()) {
    harness.responses[CHIP_PATH] = { data: { items: [], total: 1, disabled: false } };
    harness.responses[QUEUE_PATH] = { data: pending([entry]) };
    harness.responses[OPTIONS_PATH] = { data: OPTIONS };
    harness.responses[BUILD_ORDER_PATH] = {
      data: {
        my_race: "Protoss",
        opp_race: "Zerg",
        events: [{ time: 30, name: "Gateway" }],
        opp_events: [{ time: 40, name: "SpawningPool" }],
      },
    };
    renderAlert();
    return openQueue();
  }

  it("shows the opponent's build read-only with its Corrected marker", () => {
    const dialog = setup();
    const entry = within(dialog).getByTestId("build-checkin-queue-item");
    expect(entry.textContent).toContain("Opponent: Ling Flood");
    expect(within(entry).getByTestId("corrected-badge").getAttribute("title")).toBe(
      "Replay classified as Zerg - 12 Pool",
    );
    expect(within(entry).queryByRole("button", { name: /Change the opponent/ })).toBeNull();
  });

  it("adds your build directly from the replay label and checks it in for that game", async () => {
    harness.apiCall.mockResolvedValue({
      ...withOpponent(),
      status: "confirmed",
      applied: true,
      build: { key: "custom:own-opening", name: "Own Opening", slug: "own-opening", source: "custom" },
    });
    const dialog = setup();
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add new build… for your plan" }));
    await screen.findByRole("dialog", { name: "Build editor" });
    expect(harness.editor).toMatchObject({
      gameId: "g1",
      perspective: "you",
      race: "Protoss",
      vsRace: "Zerg",
      defaultName: "PvZ — New build",
      events: [{ time: 30, name: "Gateway" }],
      lockMatchup: true,
      createOnly: true,
    });
    act(() => {
      harness.editor?.onSaved?.("own-opening", { name: "Own Opening" } as never, {
        reclassifyRequested: false,
      });
    });
    await waitFor(() => expect(harness.toast.success).toHaveBeenCalledWith("Saved to your library and checked in"));
    expect(harness.apiCall).toHaveBeenCalledTimes(1);
    const [, path, init] = harness.apiCall.mock.calls[0];
    expect(path).toBe("/v1/games/g1/build-intent");
    expect(JSON.parse(init.body)).toEqual({ action: "confirm", buildKey: "custom:own-opening" });
    expect(harness.paths).toContain(BUILD_ORDER_PATH);
    expect(harness.paths).toContain(`${QUEUE_PATH}#checkin-1`);
  });

  it("adds your build from the picker and checks it in", async () => {
    harness.apiCall.mockResolvedValue({
      ...withOpponent(),
      status: "confirmed",
      applied: true,
      build: { key: "custom:proxy-gate", name: "Proxy Gate", slug: "proxy-gate", source: "custom" },
    });
    const dialog = setup();
    fireEvent.click(within(dialog).getByRole("button", { name: "Change…" }));
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "Proxy Gate" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add “Proxy Gate” as a new build…" }),
    );
    await screen.findByRole("dialog", { name: "Build editor" });
    expect(harness.editor).toMatchObject({
      gameId: "g1",
      perspective: "you",
      race: "Protoss",
      vsRace: "Zerg",
      defaultName: "Proxy Gate",
      lockMatchup: true,
      createOnly: true,
    });
    act(() => {
      harness.editor?.onSaved?.("proxy-gate", { name: "Proxy Gate" } as never, {
        reclassifyRequested: false,
      });
    });
    await waitFor(() =>
      expect(harness.toast.success).toHaveBeenCalledWith("Saved to your library and checked in"),
    );
    const [, path, init] = harness.apiCall.mock.calls[0];
    expect(path).toBe("/v1/games/g1/build-intent");
    expect(JSON.parse(init.body)).toEqual({ action: "confirm", buildKey: "custom:proxy-gate" });
    expect(harness.paths).toContain(`${QUEUE_PATH}#checkin-1`);
  });

  it("adds the opponent's build from its line as a correction", async () => {
    harness.apiCall.mockResolvedValue(withOpponent());
    const dialog = setup();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add opponent build… from the opponent's replay" }),
    );
    await screen.findByRole("dialog", { name: "Build editor" });
    expect(harness.editor).toMatchObject({
      gameId: "g1",
      perspective: "opponent",
      race: "Zerg",
      vsRace: "Protoss",
      defaultName: "Zerg build vs Protoss",
      events: [{ time: 40, name: "SpawningPool" }],
      lockMatchup: true,
      createOnly: true,
    });
    expect(harness.paths).toContain(BUILD_ORDER_PATH);
    act(() => {
      harness.editor?.onSaved?.("ling-flood-2", { name: "Ling Flood 2" } as never, {
        reclassifyRequested: false,
      });
    });
    await waitFor(() => expect(harness.toast.success).toHaveBeenCalledWith("Saved to your library and checked in"));
    expect(harness.apiCall).toHaveBeenCalledTimes(1);
    expect(harness.apiCall.mock.calls[0][1]).toBe("/v1/games/g1/build-intent");
    expect(JSON.parse(harness.apiCall.mock.calls[0][2].body)).toEqual({
      action: "opponent",
      opponentBuildKey: "custom:ling-flood-2",
    });

    // Closing the editor after the game left the queue keeps focus in the dialog.
    harness.responses[QUEUE_PATH] = { data: pending([]) };
    refresh();
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
      act(() => {
        vi.runAllTimers();
      });
    } finally {
      vi.useRealTimers();
    }
    expect(screen.queryByRole("dialog", { name: "Build editor" })).toBeNull();
    expect(within(dialog).getByText("You're all caught up")).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("keeps a refused build saved, says why and reopens the picker on a retryable failure", async () => {
    harness.apiCall.mockRejectedValueOnce({ status: 400, code: "unknown_build", message: "x" });
    const dialog = setup(withOpponent({ opponent: null }));
    expect(within(dialog).queryByText(/^Opponent:/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Change…" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add new build…" }));
    await screen.findByRole("dialog", { name: "Build editor" });
    act(() => {
      harness.editor?.onSaved?.("misfit", { name: "Misfit" } as never, { reclassifyRequested: false });
    });
    await waitFor(() =>
      expect(harness.toast.error).toHaveBeenCalledWith(
        "Saved to your library, but this game can't take it as its check-in",
        { description: "It doesn't fit this game's matchup." },
      ),
    );

    harness.apiCall.mockRejectedValueOnce({ status: 0, message: "Failed to fetch" });
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Change…" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add new build…" }));
    await screen.findByRole("dialog", { name: "Build editor" });
    act(() => {
      harness.editor?.onSaved?.("custom-two", { name: "Custom Two" } as never, {
        reclassifyRequested: false,
      });
    });
    await waitFor(() =>
      expect(harness.toast.error).toHaveBeenLastCalledWith(
        "Saved to your library, but the check-in didn't go through",
        { description: "Failed to fetch" },
      ),
    );
    // The lists refresh and the picker moves to the new build (not listed
    // in this canned response, so nothing is selected and Confirm waits).
    await waitFor(() => expect(harness.paths).toContain(`${OPTIONS_PATH}#checkin-1`));
    const listbox = within(dialog).getByRole("listbox", { name: "Build you went for in PvZ" });
    await waitFor(() =>
      expect(within(listbox).queryByRole("option", { selected: true })).toBeNull(),
    );
    expect(within(dialog).getByRole("button", { name: "Confirm" }).hasAttribute("disabled")).toBe(true);
  });

  it("reopens the picker after a failed check-in only once, not every time the queue opens", async () => {
    harness.apiCall.mockRejectedValueOnce({ status: 0, message: "Failed to fetch" });
    let dialog = setup(withOpponent({ opponent: null }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Change…" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add new build…" }));
    await screen.findByRole("dialog", { name: "Build editor" });
    act(() => {
      harness.editor?.onSaved?.("custom-two", { name: "Custom Two" } as never, {
        reclassifyRequested: false,
      });
    });
    await waitFor(() => expect(harness.toast.error).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    expect(within(dialog).getByRole("listbox", { name: "Build you went for in PvZ" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Build check-ins" })).toBeNull();

    dialog = openQueue();
    await act(async () => {});
    expect(within(dialog).queryByRole("listbox")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Change…" })).toBeTruthy();
  });

  it("never reopens a picker for a build saved after the list closed", async () => {
    harness.apiCall.mockRejectedValueOnce({ status: 0, message: "Failed to fetch" });
    let dialog = setup(withOpponent({ opponent: null }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Change…" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add new build…" }));
    await screen.findByRole("dialog", { name: "Build editor" });
    // The editor's save is still out when the player leaves the list.
    const onSaved = harness.editor?.onSaved;
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await act(async () => {
      onSaved?.("custom-two", { name: "Custom Two" } as never, { reclassifyRequested: false });
    });
    // Closing retires the game's action scope before the saved editor callback.
    expect(harness.apiCall).not.toHaveBeenCalled();
    expect(harness.toast.error).not.toHaveBeenCalled();

    dialog = openQueue();
    await act(async () => {});
    expect(within(dialog).queryByRole("listbox")).toBeNull();
  });

  it("never reopens a picker for a check-in that failed after the list closed", async () => {
    let fail: (reason: unknown) => void = () => {};
    harness.apiCall.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    let dialog = setup(withOpponent({ opponent: null }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Change…" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add new build…" }));
    await screen.findByRole("dialog", { name: "Build editor" });
    act(() => {
      harness.editor?.onSaved?.("custom-two", { name: "Custom Two" } as never, {
        reclassifyRequested: false,
      });
    });
    // The editor closes and the player leaves while the check-in is out.
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await act(async () => fail({ status: 0, message: "Failed to fetch" }));
    expect(harness.apiCall).toHaveBeenCalledTimes(1);
    expect(harness.toast.error).not.toHaveBeenCalled();

    dialog = openQueue();
    await act(async () => {});
    expect(within(dialog).queryByRole("listbox")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Change…" })).toBeTruthy();
  });
});
