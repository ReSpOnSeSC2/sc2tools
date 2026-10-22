import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
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
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken, isLoaded: true, isSignedIn: true }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("@/lib/useUserSocket", () => ({
  useUserSocket: (handlers: Record<string, (payload: unknown) => void> | null) => {
    harness.socket = handlers;
  },
}));
vi.mock("@/components/ui/Toast", () => ({
  useToastOptional: () => ({ toast: harness.toast }),
}));
vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => harness.apiCall(...args),
  useApi: (path: string | null) => {
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
}));

import { BuildCheckInAlert } from "../BuildCheckInAlert";
import { BuildCheckInProvider } from "../BuildCheckInProvider";

const CHIP_PATH = "/v1/build-intents/pending?limit=1";
const QUEUE_PATH = "/v1/build-intents/pending?limit=25";
const OPTIONS_PATH = "/v1/build-intents/options?matchup=PvZ";

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
    expect(harness.paths).toContain(OPTIONS_PATH);
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
