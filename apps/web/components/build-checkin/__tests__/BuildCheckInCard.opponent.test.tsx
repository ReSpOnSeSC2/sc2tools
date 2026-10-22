/**
 * BuildCheckInCard — the opponent's build row, "Add new build" through the
 * custom-build editor (stubbed here; it has its own tests) and the
 * `?newBuild=` deep link.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { BuildEditorModalProps } from "@/components/builds/editor";
import type { GameIntentState } from "@/lib/buildIntent";

const harness = vi.hoisted(() => ({
  intent: undefined as GameIntentState | undefined,
  error: undefined as { status: number; message: string; code?: string } | undefined,
  buildOrder: undefined as unknown,
  validating: false,
  paths: [] as string[],
  mutate: vi.fn(),
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "token"),
  socket: null as Record<string, (payload: unknown) => void> | null,
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  editor: null as BuildEditorModalProps | null,
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
// The real editor is covered by its own tests; this stub records its props.
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
vi.mock("@/lib/clientApi", async () => {
  const React = await import("react");
  return {
    apiCall: (...args: unknown[]) => harness.apiCall(...args),
    useApi: (path: string | null) => {
      const [, rerender] = React.useReducer((value: number) => value + 1, 0);
      if (path?.endsWith("/build-order")) {
        return {
          data: harness.buildOrder,
          error: undefined,
          isLoading: harness.buildOrder === undefined,
          isValidating: false,
          mutate: vi.fn(),
        };
      }
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
import {
  BUILD_ORDER,
  CORRECTED,
  confirmedResponse,
  intent,
  opponentState,
  OPP_OPTIONS,
} from "./cardFixtures";

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
  harness.buildOrder = undefined;
  harness.editor = null;
  harness.validating = false;
  harness.paths = [];
  harness.socket = null;
  harness.mutate.mockReset();
  harness.apiCall.mockReset();
  harness.toast.success.mockReset();
  harness.toast.error.mockReset();
});

function opponentRow() {
  return screen.getByRole("group", { name: /^Opponent's build:/ });
}

/** The editor chunk loads through next/dynamic; wait for the stub. */
async function editorProps() {
  await screen.findByRole("dialog", { name: "Build editor" });
  return harness.editor!;
}

describe("BuildCheckInCard — opponent's build", () => {
  it("shows the replay's opponent label and corrects it from the opponent list", async () => {
    harness.intent = intent({ opponent: opponentState() });
    harness.apiCall.mockResolvedValue({
      ...confirmedResponse("x", "x"),
      status: "pending",
      applied: false,
      build: null,
      opponent: { ...CORRECTED, options: undefined },
    });
    renderCard();
    const row = opponentRow();
    expect(row.textContent).toContain("Zerg - 12 Pool");
    expect(within(row).queryByTestId("corrected-badge")).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "Change the opponent's build" }));
    const listbox = screen.getByRole("listbox", { name: "Opponent's build in PvZ" });
    expect(within(listbox).getByRole("group", { name: "Faced before" })).toBeTruthy();
    expect(within(listbox).getByRole("group", { name: "All builds" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Search opponent builds…"));
    // Starts on the replay's own label, so Save waits for a change.
    expect(within(listbox).getByRole("option", { selected: true }).getAttribute("data-build-key")).toBe(
      "zerg-12-pool",
    );
    expect(screen.getByRole("button", { name: "Save Zerg - 12 Pool" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Use replay's label" })).toBeNull();

    fireEvent.click(
      within(listbox).getAllByRole("option").find(
        (node) => node.getAttribute("data-build-key") === "custom:ling-flood",
      )!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Ling Flood" }));
    await waitFor(() => expect(harness.toast.success).toHaveBeenCalledWith("Opponent's build set to Ling Flood"));
    expect(JSON.parse(harness.apiCall.mock.calls[0][2].body)).toEqual({
      action: "opponent",
      opponentBuildKey: "custom:ling-flood",
    });
    // The response has no build lists: the loaded ones stay.
    expect(harness.intent?.opponent?.options).toEqual(OPP_OPTIONS);
    // The picker closes after the write resolves and hands focus back.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Change the opponent's build" }),
      ),
    );
    const corrected = within(opponentRow()).getByTestId("corrected-badge");
    expect(corrected.getAttribute("title")).toBe("Replay classified as Zerg - 12 Pool");
  });

  it("goes back to the replay's label and sends unsaved notes along", async () => {
    harness.intent = intent({ opponent: CORRECTED });
    harness.apiCall.mockResolvedValue({
      ...confirmedResponse("x", "x", "Hid the pool"),
      opponent: { ...opponentState(), options: undefined },
    });
    renderCard();
    expect(within(opponentRow()).getByTestId("corrected-badge")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/What threw the build off/), {
      target: { value: "Hid the pool" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change the opponent's build" }));
    fireEvent.click(screen.getByRole("button", { name: "Use replay's label" }));
    await waitFor(() =>
      expect(harness.toast.success).toHaveBeenCalledWith("Opponent's build reset to the replay's label"),
    );
    expect(JSON.parse(harness.apiCall.mock.calls[0][2].body)).toEqual({
      action: "opponent",
      opponentBuildKey: null,
      notes: "Hid the pool",
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Discard" })).toBeNull());
  });

  it("explains an opponent build that is no longer available", async () => {
    harness.intent = intent({ opponent: opponentState() });
    harness.apiCall.mockRejectedValue({ status: 400, code: "unknown_opponent_build", message: "x" });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Change the opponent's build" }));
    fireEvent.click(screen.getAllByRole("option")[2]);
    fireEvent.click(screen.getByRole("button", { name: "Save ZvP - Ling Bane Bust" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That opponent build isn't available for this matchup any more. Pick another one.",
    );
    expect(harness.toast.error).toHaveBeenCalledWith("Couldn't save the opponent's build", {
      description: expect.stringMatching(/opponent build isn't available/),
    });
  });

  it("names a closer rules match and hides the row without a matchup", () => {
    harness.intent = intent({
      opponent: opponentState({
        detected: { name: "Zerg Standard Play (Unclassified)", slug: null, key: null },
        label: "Zerg Standard Play (Unclassified)",
        suggestion: {
          key: "custom:ling-flood",
          name: "Ling Flood",
          slug: "ling-flood",
          source: "custom",
          reason: "rules",
          passedRules: 3,
          ruleCount: 4,
        },
      }),
    });
    renderCard();
    expect(screen.getByText("Closest match")).toBeTruthy();
    expect(screen.getByText("3/4 rules matched")).toBeTruthy();
    cleanup();

    harness.intent = intent({ opponent: null });
    renderCard();
    expect(screen.queryByRole("group", { name: /^Opponent's build:/ })).toBeNull();
  });
});

describe("BuildCheckInCard — Add new build", () => {
  it("opens the editor on your side of the replay and checks the new build in", async () => {
    harness.intent = intent({ opponent: opponentState() });
    harness.buildOrder = BUILD_ORDER;
    harness.apiCall.mockResolvedValue({
      ...confirmedResponse("custom:proxy-gate", "Proxy Gate"),
      build: { key: "custom:proxy-gate", name: "Proxy Gate", slug: "proxy-gate", source: "custom" },
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Proxy Gate" } });
    fireEvent.click(screen.getByRole("button", { name: "Add “Proxy Gate” as a new build…" }));

    const props = await editorProps();
    expect(props).toMatchObject({
      open: true,
      gameId: "g1",
      events: BUILD_ORDER.events,
      race: "Protoss",
      vsRace: "Zerg",
      perspective: "you",
      defaultName: "Proxy Gate",
      mode: "create",
      lockMatchup: true,
      createOnly: true,
    });

    act(() => {
      props.onSaved?.("proxy-gate", { name: "Proxy Gate " } as never, { reclassifyRequested: false });
    });
    await waitFor(() =>
      expect(harness.toast.success).toHaveBeenCalledWith("Saved to your library and checked in"),
    );
    expect(JSON.parse(harness.apiCall.mock.calls[0][2].body)).toEqual({
      action: "confirm",
      buildKey: "custom:proxy-gate",
    });
    await waitFor(() => expect(screen.getByText("Planned build")).toBeTruthy());
    // The refresh after the write brings the new build into the lists.
    await waitFor(() =>
      expect(harness.paths.at(-1)).toBe("/v1/games/g1/build-intent?include=options#checkin-1"),
    );
  });

  it("gives focus back to Change… once the new build is checked in", async () => {
    harness.intent = intent({ opponent: opponentState() });
    harness.buildOrder = BUILD_ORDER;
    harness.apiCall.mockResolvedValue({
      ...confirmedResponse("custom:proxy-gate", "Proxy Gate"),
      build: { key: "custom:proxy-gate", name: "Proxy Gate", slug: "proxy-gate", source: "custom" },
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Proxy Gate" } });
    const add = screen.getByRole("button", { name: "Add “Proxy Gate” as a new build…" });
    add.focus();
    fireEvent.click(add);
    const props = await editorProps();
    act(() => {
      props.onSaved?.("proxy-gate", { name: "Proxy Gate" } as never, { reclassifyRequested: false });
    });
    await waitFor(() => expect(screen.getByText("Planned build")).toBeTruthy());
    // The picker (and the button that opened the editor) is gone.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change…" }));
  });

  it("builds the opponent's side from their events and corrects it", async () => {
    harness.intent = intent({ opponent: opponentState() });
    harness.buildOrder = BUILD_ORDER;
    harness.apiCall.mockResolvedValue({
      ...intent(),
      options: undefined,
      opponent: { ...CORRECTED, options: undefined },
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Change the opponent's build" }));
    fireEvent.click(screen.getByRole("button", { name: "Add new build…" }));

    const props = await editorProps();
    expect(props).toMatchObject({
      events: BUILD_ORDER.opp_events,
      race: "Zerg",
      vsRace: "Protoss",
      perspective: "opponent",
      defaultName: "Zerg build vs Protoss",
      lockMatchup: true,
      createOnly: true,
    });
    act(() => {
      props.onSaved?.("ling-flood", { name: "Ling Flood" } as never, { reclassifyRequested: true });
    });
    await waitFor(() =>
      expect(harness.toast.success).toHaveBeenCalledWith("Saved to your library and checked in"),
    );
    expect(JSON.parse(harness.apiCall.mock.calls[0][2].body)).toEqual({
      action: "opponent",
      opponentBuildKey: "custom:ling-flood",
    });
    // Checked in: the opponent picker closes on the corrected build.
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search opponent builds…")).toBeNull(),
    );
    expect(within(opponentRow()).getByTestId("corrected-badge")).toBeTruthy();
  });

  it("keeps a saved build the game can't take and says why", async () => {
    harness.intent = intent({ opponent: opponentState() });
    harness.buildOrder = BUILD_ORDER;
    harness.apiCall.mockRejectedValue({ status: 400, code: "unknown_build", message: "x" });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    fireEvent.click(screen.getByRole("button", { name: "Add new build…" }));
    const props = await editorProps();
    expect(props.defaultName).toBe("PvZ — New build");
    act(() => {
      props.onSaved?.("pvz-new-build", { name: "PvZ — New build" } as never, { reclassifyRequested: false });
    });
    await waitFor(() =>
      expect(harness.toast.error).toHaveBeenCalledWith(
        "Saved to your library, but this game can't take it as its check-in",
        { description: "It doesn't fit this game's matchup." },
      ),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Saved to your library, but this game can't take it as its check-in. It doesn't fit this game's matchup.",
    );
    // The lists refresh so the build shows up wherever it fits, and the
    // picker waits on it: nothing listed is selected, so Confirm waits.
    expect(harness.mutate).toHaveBeenCalledWith(undefined);
    await waitFor(() =>
      expect(within(screen.getByRole("listbox", { name: "Build you went for" }))
        .queryByRole("option", { selected: true })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Confirm" }).hasAttribute("disabled")).toBe(true);
  });

  it("leaves the new build selected when the check-in write failed", async () => {
    harness.intent = intent({ opponent: opponentState() });
    harness.buildOrder = BUILD_ORDER;
    harness.apiCall.mockRejectedValue({ status: 429, code: "rate_limited", message: "x" });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Change the opponent's build" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText("Search opponent builds…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change the opponent's build" }));
    fireEvent.click(screen.getByRole("button", { name: "Add new build…" }));
    const props = await editorProps();
    act(() => {
      props.onSaved?.("ling-flood", { name: "Ling Flood" } as never, { reclassifyRequested: false });
    });
    await waitFor(() =>
      expect(harness.toast.error).toHaveBeenCalledWith(
        "Saved to your library, but the check-in didn't go through",
        { description: expect.stringMatching(/Too many check-in changes/) },
      ),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("listbox", { name: "Opponent's build in PvZ" }))
          .getByRole("option", { selected: true })
          .getAttribute("data-build-key"),
      ).toBe("custom:ling-flood"),
    );
    expect(screen.getByRole("button", { name: "Save Ling Flood" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows a closable loading dialog while the build order loads", async () => {
    harness.intent = intent();
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    fireEvent.click(screen.getByRole("button", { name: "Add new build…" }));
    const loading = screen.getByRole("dialog", { name: "Add a new build" });
    expect(within(loading).getByRole("status").textContent).toContain("Loading this game's build order");
    fireEvent.click(within(loading).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("BuildCheckInCard — ?newBuild deep link", () => {
  function renderDeepLink(side: "you" | "opponent", onOpened = vi.fn()) {
    const view = render(
      <BuildCheckInProvider>
        <BuildCheckInCard gameId="g1" initialNewBuild={side} onNewBuildOpened={onOpened} />
      </BuildCheckInProvider>,
    );
    return { ...view, onOpened };
  }

  it("expands an unchecked game and opens the editor for that side once", async () => {
    harness.intent = intent({ status: "none", suggestion: null, opponent: opponentState() });
    harness.buildOrder = BUILD_ORDER;
    const scrollIntoView = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const { rerender, onOpened } = renderDeepLink("opponent");
      expect(screen.getByTestId("build-checkin-card")).toBeTruthy();
      const props = await editorProps();
      expect(props.perspective).toBe("opponent");
      expect(onOpened).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
      expect(screen.queryByRole("dialog", { name: "Build editor" })).toBeNull();
      // The page drops the param; a later refresh of the state doesn't reopen it.
      rerender(
        <BuildCheckInProvider>
          <BuildCheckInCard gameId="g1" initialNewBuild={null} onNewBuildOpened={onOpened} />
        </BuildCheckInProvider>,
      );
      act(() => {
        harness.socket?.["build-intent:changed"]({ gameId: "g1" });
      });
      expect(screen.queryByRole("dialog", { name: "Build editor" })).toBeNull();
      expect(onOpened).toHaveBeenCalledTimes(1);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("still saves to the library for an ineligible game, without a check-in", async () => {
    harness.intent = intent({ eligible: false, ineligibleReason: "too_short", status: "none" });
    harness.buildOrder = BUILD_ORDER;
    renderDeepLink("you");
    expect(screen.getByTestId("build-checkin-ineligible")).toBeTruthy();
    const props = await editorProps();
    act(() => {
      props.onSaved?.("short-one", { name: "Short one" } as never, { reclassifyRequested: false });
    });
    expect(harness.apiCall).not.toHaveBeenCalled();
    expect(harness.toast.error).toHaveBeenCalledWith(
      "Saved to your library, but this game can't take it as its check-in",
      { description: "Games under 45 seconds never count toward a build." },
    );
  });

  it("gives up quietly when the game has no check-in", () => {
    harness.error = { status: 404, message: "Not found." };
    const { onOpened } = renderDeepLink("you");
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("BuildCheckInCard — unchecked games and the opponent", () => {
  it("mentions the opponent's build in the compact action", () => {
    harness.intent = intent({ status: "none", suggestion: null, opponent: opponentState() });
    renderCard();
    expect(screen.getByTestId("build-checkin-compact").textContent).toContain(
      "You can correct the opponent's build here too.",
    );
  });

  it("keeps a corrected opponent build visible on an otherwise unchecked game", () => {
    harness.intent = intent({ status: "none", suggestion: null, opponent: CORRECTED });
    renderCard();
    expect(screen.queryByTestId("build-checkin-compact")).toBeNull();
    expect(within(opponentRow()).getByTestId("corrected-badge")).toBeTruthy();
    // Shown by the page, not opened by the player: no picker, focus untouched.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("No planned build yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set planned build" }));
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("build-checkin-card")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

describe("BuildCheckInCard — Cancel on an unchecked game", () => {
  it("closes your picker in one click once the opponent's build is corrected", async () => {
    harness.intent = intent({ status: "none", suggestion: null, opponent: opponentState() });
    harness.apiCall.mockResolvedValue({
      ...intent({ status: "none", suggestion: null }),
      options: undefined,
      opponent: { ...CORRECTED, options: undefined },
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Set planned build" }));
    fireEvent.click(screen.getByRole("button", { name: "Change the opponent's build" }));
    const listbox = screen.getByRole("listbox", { name: "Opponent's build in PvZ" });
    fireEvent.click(
      within(listbox).getAllByRole("option").find(
        (node) => node.getAttribute("data-build-key") === "custom:ling-flood",
      )!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Ling Flood" }));
    await waitFor(() =>
      expect(screen.queryByRole("listbox", { name: "Opponent's build in PvZ" })).toBeNull(),
    );
    const yours = screen.getByRole("group", { name: "Your build" });
    fireEvent.click(within(yours).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("listbox", { name: /Build you went for/ })).toBeNull();
    // The corrected opponent keeps the full card: nothing to fold back to.
    expect(screen.queryByTestId("build-checkin-compact")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Set planned build" }));
  });

  it("folds back to the compact action while nothing is set", () => {
    harness.intent = intent({ status: "none", suggestion: null, opponent: opponentState() });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Set planned build" }));
    const yours = screen.getByRole("group", { name: "Your build" });
    fireEvent.click(within(yours).getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("build-checkin-compact")).toBeTruthy();
  });
});

describe("BuildCheckInCard — staying open", () => {
  it("doesn't fold back to the compact action after resetting the opponent's build", async () => {
    harness.intent = intent({ status: "none", suggestion: null, opponent: CORRECTED });
    harness.apiCall.mockResolvedValue({
      ...intent({ status: "none", suggestion: null }),
      options: undefined,
      opponent: { ...opponentState(), options: undefined },
    });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Change the opponent's build" }));
    fireEvent.click(screen.getByRole("button", { name: "Use replay's label" }));
    await waitFor(() =>
      expect(harness.toast.success).toHaveBeenCalledWith("Opponent's build reset to the replay's label"),
    );
    await waitFor(() =>
      expect(within(opponentRow()).queryByTestId("corrected-badge")).toBeNull(),
    );
    expect(screen.queryByTestId("build-checkin-compact")).toBeNull();
    expect(screen.getByTestId("build-checkin-card")).toBeTruthy();
  });
});
