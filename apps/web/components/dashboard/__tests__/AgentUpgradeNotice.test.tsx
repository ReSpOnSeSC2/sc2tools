import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_STATUS_REFRESH_MS,
  AgentUpgradeNotice,
  agentUpgradeNoticeState,
  isAgentVersionAtLeast,
} from "../AgentUpgradeNotice";

const NOW = Date.parse("2026-08-13T17:00:00.000Z");
const useApiMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  useApiMock.mockReturnValue({ data: undefined, isLoading: true, error: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useApiMock.mockReset();
});

describe("agentUpgradeNoticeState", () => {
  it("handles missing, offline, and unknown devices conservatively", () => {
    expect(agentUpgradeNoticeState([], NOW).kind).toBe("missing");
    expect(
      agentUpgradeNoticeState(
        [{ agentVersion: "0.15.20", lastSeenAt: "2026-08-13T16:50:00Z" }],
        NOW,
      ).kind,
    ).toBe("offline");
    expect(
      agentUpgradeNoticeState(
        [{ agentVersion: null, lastSeenAt: "2026-08-13T16:59:00Z" }],
        NOW,
      ).kind,
    ).toBe("unknown");
  });

  it("uses the most recently active device and requires a live heartbeat", () => {
    const state = agentUpgradeNoticeState(
      [
        { agentVersion: "0.15.20", lastSeenAt: "2026-08-13T16:50:00Z" },
        { agentVersion: "0.15.19", lastSeenAt: "2026-08-13T16:59:30Z" },
      ],
      NOW,
    );
    expect(state.kind).toBe("outdated");
  });

  it("becomes ready only for a live agent at or above 0.15.20", () => {
    expect(
      agentUpgradeNoticeState(
        [{ agentVersion: "0.15.19", lastSeenAt: "2026-08-13T16:59:30Z" }],
        NOW,
      ).kind,
    ).toBe("outdated");
    expect(
      agentUpgradeNoticeState(
        [{ agentVersion: "0.15.20", lastSeenAt: "2026-08-13T16:59:30Z" }],
        NOW,
      ).kind,
    ).toBe("ready");
  });
});

describe("isAgentVersionAtLeast", () => {
  it.each([
    ["0.15.19", false],
    ["0.15.20-rc.1", false],
    ["v0.15.20", true],
    ["0.15.20+windows", true],
    ["0.16.0", true],
    ["unknown", false],
  ])("compares %s conservatively", (version, expected) => {
    expect(isAgentVersionAtLeast(version, "0.15.20")).toBe(expected);
  });
});

describe("AgentUpgradeNotice", () => {
  it("stays visible while checking and links to the real download page", () => {
    render(
      <AgentUpgradeNotice
        initialAgent={{
          paired: true,
          version: "0.15.19",
          lastSeenAt: "2026-08-13T16:59:30Z",
        }}
      />,
    );

    expect(screen.getByText("Checking your connected agent")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /download update/i }).getAttribute("href"),
    ).toBe("/download");
    expect(useApiMock).toHaveBeenCalledWith("/v1/devices", {
      refreshInterval: expect.any(Function),
      revalidateOnFocus: true,
    });
  });

  it("polls while outdated and stops after live data reaches 0.15.20", () => {
    let response = {
      items: [
        { agentVersion: "0.15.19", lastSeenAt: "2026-08-13T16:59:30Z" },
      ],
    };
    useApiMock.mockImplementation(() => ({
      data: response,
      isLoading: false,
      error: null,
    }));
    const { rerender } = render(
      <AgentUpgradeNotice
        initialAgent={{
          paired: true,
          version: "0.15.19",
          lastSeenAt: "2026-08-13T16:59:30Z",
        }}
      />,
    );

    expect(screen.getByText(/connected agent v0\.15\.19 is out of date/i))
      .toBeTruthy();
    const options = useApiMock.mock.calls[0]?.[1] as {
      refreshInterval: (latest?: typeof response) => number;
    };
    expect(options.refreshInterval(response)).toBe(AGENT_STATUS_REFRESH_MS);

    response = {
      items: [
        { agentVersion: "0.15.20", lastSeenAt: "2026-08-13T16:59:45Z" },
      ],
    };
    rerender(
      <AgentUpgradeNotice
        initialAgent={{
          paired: true,
          version: "0.15.19",
          lastSeenAt: "2026-08-13T16:59:30Z",
        }}
      />,
    );

    expect(screen.queryByLabelText("Required agent update")).toBeNull();
    expect(options.refreshInterval(response)).toBe(0);
  });

  it("does not fetch or render when the server snapshot is already confirmed", () => {
    render(
      <AgentUpgradeNotice
        initialAgent={{
          paired: true,
          version: "0.15.20",
          lastSeenAt: "2026-08-13T16:59:30Z",
        }}
      />,
    );

    expect(screen.queryByLabelText("Required agent update")).toBeNull();
    expect(useApiMock).toHaveBeenCalledWith(null, expect.any(Object));
  });
});
