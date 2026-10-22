import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { BuildOption, GameIntentState } from "@/lib/buildIntent";

const harness = vi.hoisted(() => ({
  intent: undefined as GameIntentState | undefined,
  error: undefined as { status: number; message: string; code?: string } | undefined,
  validating: false,
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
vi.mock("@/lib/clientApi", async () => {
  const React = await import("react");
  return {
    apiCall: (...args: unknown[]) => harness.apiCall(...args),
    useApi: (path: string | null) => {
      const [, rerender] = React.useReducer((value: number) => value + 1, 0);
      if (path) harness.paths.push(path);
      const mutate = async (next?: unknown) => {
        harness.mutate(next);
        if (typeof next === "function") {
          harness.intent = (next as (current: unknown) => GameIntentState)(harness.intent);
        } else if (next !== undefined) {
          harness.intent = next as GameIntentState;
        }
        rerender();
      };
      return {
        data: path ? harness.intent : undefined,
        error: path && !harness.intent ? harness.error : undefined,
        isLoading: false,
        isValidating: harness.validating,
        mutate,
      };
    },
  };
});

import { BuildCheckInCard } from "../BuildCheckInCard";
import { BuildCheckInProvider } from "../BuildCheckInProvider";

function option(overrides: Partial<BuildOption>): BuildOption {
  return {
    key: "pvz-stargate",
    name: "PvZ - Stargate",
    slug: null,
    source: "catalog",
    games: 3,
    wins: 2,
    losses: 1,
    checkins: 0,
    lastPlayedAt: null,
    inRandomizer: false,
    group: "yours",
    ...overrides,
  };
}

const OPTIONS = [
  option({ key: "pvz-2-stargate-phoenix", name: "PvZ - 2 Stargate Phoenix" }),
  option({ key: "custom:dt-3-gate", name: "DT into 3 Gate", slug: "dt-3-gate", source: "custom" }),
  option({ key: "pvz-blink-stalkers", name: "PvZ - Blink Stalkers", group: "all" }),
];

function intent(overrides: Partial<GameIntentState> = {}): GameIntentState {
  return {
    gameId: "g1",
    matchup: "PvZ",
    myRace: "Protoss",
    oppRace: "Zerg",
    result: "Victory",
    date: "2026-10-22T18:00:00.000Z",
    durationSec: 842,
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
      reason: "randomizer",
      passedRules: null,
      ruleCount: null,
    },
    randomizer: {
      key: "pvz-2-stargate-phoenix",
      name: "PvZ - 2 Stargate Phoenix",
      slug: null,
      source: "catalog",
    },
    randomizerDeviated: false,
    detected: { name: "PvZ - Macro Transition (Unclassified)", slug: null, key: null },
    executed: false,
    notes: "",
    origin: null,
    via: null,
    confirmedAt: null,
    updatedAt: null,
    prefs: { enabled: true, askAtLoading: true, askAfterGame: true },
    options: OPTIONS,
    usualKey: "custom:dt-3-gate",
    ...overrides,
  };
}

function confirmedResponse(key: string, name: string, notes = ""): GameIntentState {
  const { options: _options, usualKey: _usualKey, ...rest } = intent({
    status: "confirmed",
    applied: true,
    build: { key, name, slug: null, source: "catalog" },
    notes,
  });
  return rest;
}

function renderCard(onChanged = vi.fn()) {
  render(
    <BuildCheckInProvider>
      <BuildCheckInCard gameId="g1" onChanged={onChanged} />
    </BuildCheckInProvider>,
  );
  return { onChanged };
}

afterEach(() => {
  cleanup();
  harness.intent = undefined;
  harness.error = undefined;
  harness.validating = false;
  harness.paths = [];
  harness.socket = null;
  harness.mutate.mockReset();
  harness.apiCall.mockReset();
  harness.toast.success.mockReset();
  harness.toast.error.mockReset();
});

describe("BuildCheckInCard — pending", () => {
  it("shows planned vs detected with the suggestion and its reason", () => {
    harness.intent = intent();
    renderCard();
    const card = screen.getByTestId("build-checkin-card");
    expect(within(card).getByRole("heading", { name: "Build check-in" })).toBeTruthy();
    expect(within(card).getByText("Needs check-in")).toBeTruthy();
    expect(within(card).getByText("PvZ - 2 Stargate Phoenix")).toBeTruthy();
    expect(within(card).getByText("Randomizer roll")).toBeTruthy();
    expect(within(card).getByText("PvZ - Macro Transition (Unclassified)")).toBeTruthy();
    expect(harness.paths[0]).toBe("/v1/games/g1/build-intent?include=options#checkin-0");
  });

  it("confirms the suggestion, keeps the build list and refreshes every surface", async () => {
    harness.intent = intent();
    harness.apiCall.mockResolvedValue(
      confirmedResponse("pvz-2-stargate-phoenix", "PvZ - 2 Stargate Phoenix"),
    );
    const { onChanged } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(harness.toast.success).toHaveBeenCalled());

    const [, path, init] = harness.apiCall.mock.calls[0];
    expect(path).toBe("/v1/games/g1/build-intent");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({
      action: "confirm",
      buildKey: "pvz-2-stargate-phoenix",
    });
    expect(harness.toast.success).toHaveBeenCalledWith("Counted toward PvZ - 2 Stargate Phoenix");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(harness.intent?.options).toEqual(OPTIONS);
    expect(screen.getByText("Checked in")).toBeTruthy();
    expect(screen.getByText("Planned build")).toBeTruthy();
    // The local write bumps the shared revision, so the key changes.
    expect(harness.paths.at(-1)).toBe("/v1/games/g1/build-intent?include=options#checkin-1");
  });

  it("changes the build through the picker and sends unsaved notes along", async () => {
    harness.intent = intent();
    harness.apiCall.mockResolvedValue(
      confirmedResponse("custom:dt-3-gate", "DT into 3 Gate", "Scouted early"),
    );
    renderCard();
    fireEvent.change(screen.getByLabelText(/What threw the build off/), {
      target: { value: "  Scouted early" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    const combobox = screen.getByRole("combobox");
    expect(document.activeElement).toBe(combobox);
    const dt = screen.getAllByRole("option").find(
      (node) => node.getAttribute("data-build-key") === "custom:dt-3-gate",
    );
    expect(within(dt!).getByText("Usual")).toBeTruthy();
    fireEvent.click(dt!);
    fireEvent.click(screen.getByRole("button", { name: "Confirm DT into 3 Gate" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalled());
    expect(JSON.parse(harness.apiCall.mock.calls[0][2].body)).toEqual({
      action: "confirm",
      buildKey: "custom:dt-3-gate",
      notes: "  Scouted early",
    });
    // The server's trimmed notes become the clean baseline.
    await waitFor(() =>
      expect((screen.getByLabelText(/What threw the build off/) as HTMLTextAreaElement).value).toBe(
        "Scouted early",
      ),
    );
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  it("marks the game as no set build", async () => {
    harness.intent = intent();
    harness.apiCall.mockResolvedValue({
      ...confirmedResponse("x", "x"),
      status: "skipped",
      applied: false,
      build: null,
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "No set build" }));
    await waitFor(() => expect(harness.toast.success).toHaveBeenCalledWith("Marked as no set build"));
    expect(JSON.parse(harness.apiCall.mock.calls[0][2].body)).toEqual({ action: "skip" });
    expect(screen.getByText(/keeps the replay's own label/)).toBeTruthy();
  });

  it("explains a not_eligible refusal and refetches the state", async () => {
    harness.intent = intent();
    harness.apiCall.mockRejectedValue({ status: 409, code: "not_eligible", message: "not_eligible" });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/can't take a check-in/);
    expect(harness.toast.error).toHaveBeenCalledWith("Couldn't save your check-in", {
      description: expect.stringMatching(/can't take a check-in/),
    });
    expect(harness.mutate).toHaveBeenCalledWith(undefined);
  });

  it("explains an unknown build without leaving the picker", async () => {
    harness.intent = intent();
    harness.apiCall.mockRejectedValue({ status: 400, code: "unknown_build", message: "unknown_build" });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    fireEvent.click(screen.getAllByRole("option")[2]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm PvZ - Blink Stalkers" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/isn't available for this matchup/);
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("opens the picker straight away when there is no suggestion", () => {
    harness.intent = intent({ suggestion: null });
    renderCard();
    expect(screen.getByText("Pick the build you were going for.")).toBeTruthy();
    expect(screen.getByRole("listbox")).toBeTruthy();
    // Opened by the page, not the player: focus stays where it was.
    expect(document.activeElement).not.toBe(screen.getByRole("combobox"));
    expect(screen.getByRole("button", { name: "Confirm" }).hasAttribute("disabled")).toBe(true);
  });

  it("names a randomizer roll the replay deviated from", () => {
    harness.intent = intent({
      randomizerDeviated: true,
      suggestion: { ...intent().suggestion!, key: "custom:dt-3-gate", name: "DT into 3 Gate", reason: "rules", passedRules: 3, ruleCount: 4 },
    });
    renderCard();
    expect(screen.getByText("3/4 rules matched")).toBeTruthy();
    expect(screen.getByText(/the replay looks different/)).toBeTruthy();
  });
});

describe("BuildCheckInCard — notes", () => {
  it("counts characters, discards and saves with a polite status", async () => {
    harness.intent = intent({ status: "confirmed", applied: true, build: { key: "custom:dt-3-gate", name: "DT into 3 Gate", slug: "dt-3-gate", source: "custom" }, notes: "Old" });
    harness.apiCall.mockResolvedValue({ ...confirmedResponse("custom:dt-3-gate", "DT into 3 Gate", "New note") });
    renderCard();
    const textarea = screen.getByLabelText(/What threw the build off/) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Old");
    expect(textarea.maxLength).toBe(1000);
    expect(screen.getByText("997 characters left")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save notes" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(textarea, { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(textarea.value).toBe("Old");

    fireEvent.change(textarea, { target: { value: "New note" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(screen.getByText("Notes saved")).toBeTruthy());
    expect(JSON.parse(harness.apiCall.mock.calls[0][2].body)).toEqual({
      action: "notes",
      notes: "New note",
    });
    expect(screen.getByText("Notes saved").getAttribute("aria-live")).toBe("polite");
    expect(harness.toast.success).toHaveBeenCalledWith("Notes saved");
  });

  it("keeps a dirty draft when the server state refreshes", () => {
    vi.useFakeTimers();
    try {
      harness.intent = intent({ notes: "" });
      renderCard();
      const textarea = screen.getByLabelText(/What threw the build off/) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "typing…" } });
      // Another device saved notes; the realtime ping refetches them.
      harness.intent = intent({ notes: "from the agent" });
      act(() => {
        harness.socket?.["build-intent:changed"]({ gameId: "g1" });
        vi.advanceTimersByTime(200);
      });
      expect(textarea.value).toBe("typing…");
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      expect(textarea.value).toBe("from the agent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts refreshed notes while the draft is clean", () => {
    vi.useFakeTimers();
    try {
      harness.intent = intent({ notes: "" });
      renderCard();
      harness.intent = intent({ notes: "from the agent" });
      act(() => {
        harness.socket?.["build-intent:changed"]({ gameId: "g1" });
        vi.advanceTimersByTime(200);
      });
      expect(
        (screen.getByLabelText(/What threw the build off/) as HTMLTextAreaElement).value,
      ).toBe("from the agent");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BuildCheckInCard — other states", () => {
  it("shows a compact action for an unchecked game that expands into the card", () => {
    harness.intent = intent({ status: "none", suggestion: null });
    renderCard();
    expect(screen.queryByTestId("build-checkin-card")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set planned build" }));
    expect(screen.getByTestId("build-checkin-card")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
    expect(screen.queryByRole("button", { name: "No set build" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("build-checkin-compact")).toBeTruthy();
  });

  it("explains why an ineligible game can't be checked in", () => {
    harness.intent = intent({ eligible: false, ineligibleReason: "too_short", status: "none" });
    renderCard();
    expect(screen.getByTestId("build-checkin-ineligible").textContent).toContain(
      "Games under 45 seconds never count toward a build.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a confirmed check-in that matched the replay", () => {
    harness.intent = intent({
      status: "confirmed",
      applied: true,
      executed: true,
      build: { key: "pvz-2-stargate-phoenix", name: "PvZ - 2 Stargate Phoenix", slug: null, source: "catalog" },
      detected: { name: "PvZ - 2 Stargate Phoenix", slug: null, key: "pvz-2-stargate-phoenix" },
    });
    renderCard();
    expect(screen.getByText("Checked in")).toBeTruthy();
    expect(screen.getByText(/matches your plan/)).toBeTruthy();
    expect(screen.getByText("This game counts toward it in your stats.")).toBeTruthy();
  });

  it("renders nothing for a 404 and a retry row for other failures", () => {
    harness.error = { status: 404, message: "Not found." };
    const { unmount } = render(<BuildCheckInCard gameId="g1" />);
    expect(document.body.textContent).toBe("");
    unmount();

    harness.error = { status: 503, message: "Something went wrong on our side." };
    render(<BuildCheckInCard gameId="g1" />);
    expect(screen.getByRole("status").textContent).toContain("Build check-in couldn't load.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(harness.mutate).toHaveBeenCalledWith(undefined);
  });

  it("refetches with a new key when another surface changes the check-in", () => {
    vi.useFakeTimers();
    try {
      harness.intent = intent();
      renderCard();
      act(() => {
        harness.socket?.["build-intent:changed"]({ gameId: "g1" });
        vi.advanceTimersByTime(200);
      });
      expect(harness.paths.at(-1)).toBe("/v1/games/g1/build-intent?include=options#checkin-1");
    } finally {
      vi.useRealTimers();
    }
  });
});
