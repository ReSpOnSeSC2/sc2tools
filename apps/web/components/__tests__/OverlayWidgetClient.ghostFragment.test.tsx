import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  assignGhostTarget,
  emptyGhostBuildConfig,
  encodeGhostBuildConfig,
  encodeGhostTarget,
  GHOST_BUILD_VERSION,
  type GhostTarget,
} from "@/lib/ghostBuild";

type SocketHandler = (...args: unknown[]) => void;
const harness = vi.hoisted(() => ({ socket: null as { handlers: Map<string, SocketHandler> } | null }));

class FakeSocket {
  connect() {}
  off() {}
  handlers = new Map<string, SocketHandler>();

  on(event: string, handler: SocketHandler) {
    this.handlers.set(event, handler); if (event === "overlay:multichat") handler({ gameWidgetsPaused: false });
  }

  emit() {}

  disconnect() {}
}

vi.mock("socket.io-client", () => ({
  io: () => { const socket = new FakeSocket(); harness.socket = socket; return socket; },
}));

vi.mock("@/lib/clientApi", () => ({
  API_BASE: "http://test.invalid",
}));

vi.mock("@/lib/timeseries", () => ({
  clientTimezone: () => "UTC",
}));

import { OverlayWidgetClient } from "../OverlayWidgetClient";

const TARGET: GhostTarget = {
  v: GHOST_BUILD_VERSION,
  name: "PvZ safe pressure",
  steps: [
    { supply: 14, t: 18, name: "Pylon" },
    { supply: 20, t: 90, name: "Stargate" },
  ],
};

const V2_PARAM = encodeGhostBuildConfig(
  assignGhostTarget(emptyGhostBuildConfig(), "PvZ", TARGET),
)!;
const LEGACY_PARAM = encodeGhostTarget(TARGET)!;

describe("OverlayWidgetClient Ghost fragment transport", () => {
  it("delivers account updates live, ignores absent/invalid fields, and empty disarm beats a valid fragment", async () => {
    window.history.replaceState(null, "", `/overlay/token/widget/ghost-build#ghost=${V2_PARAM}`);
    const view = render(<OverlayWidgetClient token="token" widget="ghost-build" />);
    await screen.findByText("1 of 9 matchups ready");
    act(() => harness.socket?.handlers.get("overlay:config")?.({ ghost: emptyGhostBuildConfig() }));
    expect(view.container.textContent).toBe("");
    act(() => harness.socket?.handlers.get("overlay:config")?.({ voicePrefs: { rate: 1.2 }, ghost: { v: 99 } }));
    expect(view.container.textContent).toBe("");
    act(() => harness.socket?.handlers.get("overlay:config")?.({ ghost: assignGhostTarget(emptyGhostBuildConfig(), "PvZ", TARGET) }));
    expect(view.container.textContent).toContain("1 of 9 matchups ready");
  });
  it("a retired socket cannot restore old assignments after an A-B-A token transition", async () => {
    const view = render(<OverlayWidgetClient token="a" widget="ghost-build" />); const old = harness.socket;
    view.rerender(<OverlayWidgetClient token="b" widget="ghost-build" />);
    view.rerender(<OverlayWidgetClient token="a" widget="ghost-build" />);
    act(() => old?.handlers.get("overlay:config")?.({ ghost: assignGhostTarget(emptyGhostBuildConfig(), "PvZ", TARGET) }));
    expect(view.container.textContent).toBe("");
  });
  it("a held bootstrap or resync snapshot cannot repaint a newer save broadcast", async () => {
    const view = render(<OverlayWidgetClient token="a" widget="ghost-build" />);
    const update = harness.socket?.handlers.get("overlay:config");
    const older = { ...assignGhostTarget(emptyGhostBuildConfig(), "PvZ", TARGET), revision: 1 };
    act(() => update?.({ ghost: { v: 2, slots: {}, revision: 2 } }));
    act(() => update?.({ ghost: older }));
    expect(view.container.textContent).toBe("");
    act(() => update?.({ ghost: { ...older, revision: 3 } }));
    expect(view.container.textContent).toContain("1 of 9 matchups ready");
  });
  beforeEach(() => {
    window.history.replaceState(null, "", "/overlay/token/widget/ghost-build");
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  it("hydrates a valid v2 #ghost loadout entirely client-side", async () => {
    window.history.replaceState(
      null,
      "",
      `/overlay/token/widget/ghost-build#ghost=${V2_PARAM}`,
    );

    render(<OverlayWidgetClient token="token" widget="ghost-build" />);

    expect(await screen.findByText("1 of 9 matchups ready")).toBeTruthy();
  });

  it("rejects malformed fragment data instead of arming the widget", async () => {
    window.history.replaceState(
      null,
      "",
      "/overlay/token/widget/ghost-build#ghost=not-valid",
    );

    const { container } = render(
      <OverlayWidgetClient token="token" widget="ghost-build" />,
    );

    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("keeps legacy ?ghost links working", () => {
    render(
      <OverlayWidgetClient
        token="token"
        widget="ghost-build"
        ghostParam={LEGACY_PARAM}
      />,
    );

    expect(screen.getByText("Matchup setup required")).toBeTruthy();
  });

  it("keeps previously copied v2 ?ghost links working", () => {
    render(
      <OverlayWidgetClient
        token="token"
        widget="ghost-build"
        ghostParam={V2_PARAM}
      />,
    );

    expect(screen.getByText("1 of 9 matchups ready")).toBeTruthy();
  });

  it("prefers a valid v2 fragment over a legacy query value", async () => {
    window.history.replaceState(
      null,
      "",
      `/overlay/token/widget/ghost-build#ghost=${V2_PARAM}`,
    );

    render(
      <OverlayWidgetClient
        token="token"
        widget="ghost-build"
        ghostParam={LEGACY_PARAM}
      />,
    );

    expect(await screen.findByText("1 of 9 matchups ready")).toBeTruthy();
    expect(screen.queryByText("Matchup setup required")).toBeNull();
  });

  it("reacts when OBS replaces the hash without a server navigation", async () => {
    render(<OverlayWidgetClient token="token" widget="ghost-build" />);
    expect(screen.queryByText("1 of 9 matchups ready")).toBeNull();

    act(() => {
      window.location.hash = `ghost=${V2_PARAM}`;
      window.dispatchEvent(new Event("hashchange"));
    });

    expect(await screen.findByText("1 of 9 matchups ready")).toBeTruthy();
  });
});
