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

class FakeSocket {
  handlers = new Map<string, SocketHandler>();

  on(event: string, handler: SocketHandler) {
    this.handlers.set(event, handler);
  }

  emit() {}

  disconnect() {}
}

vi.mock("socket.io-client", () => ({
  io: () => new FakeSocket(),
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
