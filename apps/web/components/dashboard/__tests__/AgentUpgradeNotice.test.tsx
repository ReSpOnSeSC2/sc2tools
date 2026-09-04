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
const useReleaseInfoMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock("@/components/onboarding/useReleaseInfo", () => ({
  useReleaseInfo: (...args: unknown[]) => useReleaseInfoMock(...args),
}));

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  useApiMock.mockReturnValue({ data: undefined, isLoading: true, error: null });
  useReleaseInfoMock.mockReturnValue({
    data: { latest: "0.16.3" },
    isLoading: false,
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useApiMock.mockReset();
  useReleaseInfoMock.mockReset();
});

describe("agentUpgradeNoticeState", () => {
  it("handles missing, offline, and unknown devices conservatively", () => {
    const missing = agentUpgradeNoticeState([], NOW);
    const offline = agentUpgradeNoticeState(
      [{ agentVersion: "0.15.20", lastSeenAt: "2026-08-13T16:50:00Z" }],
      NOW,
    );
    expect(missing.kind).toBe("missing");
    expect(offline.kind).toBe("offline");
    if (missing.kind !== "missing" || offline.kind !== "offline") return;
    expect(missing.title).toBe(
      "SC2 Tools Agent v0.16.3 needs to be turned on or installed",
    );
    expect(offline.title).toBe(missing.title);
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
        { agentVersion: "0.16.2", lastSeenAt: "2026-08-13T16:50:00Z" },
        { agentVersion: "0.15.19", lastSeenAt: "2026-08-13T16:59:30Z" },
      ],
      NOW,
    );
    expect(state.kind).toBe("outdated");
  });

  it("becomes ready for a live agent at or above the supported minimum", () => {
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

  it("does not treat an optional newer release as a compatibility requirement", () => {
    expect(
      agentUpgradeNoticeState(
        [{ agentVersion: "0.16.1", lastSeenAt: "2026-08-13T16:59:30Z" }],
        NOW,
        "0.17.4",
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
      screen.getByRole("link", { name: /install latest agent/i }).getAttribute("href"),
    ).toBe("/download");
    expect(useApiMock).toHaveBeenCalledWith("/v1/devices", {
      refreshInterval: expect.any(Function),
      revalidateOnFocus: true,
    });
    expect(useReleaseInfoMock).toHaveBeenCalledWith("windows");
  });

  it("polls while unsupported and stops at the supported minimum", () => {
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

  it("uses one clear inactive-agent message on mobile and desktop layouts", () => {
    useApiMock.mockReturnValue({ data: { items: [] }, isLoading: false });
    render(
      <AgentUpgradeNotice
        initialAgent={{ paired: false, version: null, lastSeenAt: null }}
      />,
    );

    expect(screen.getByText(
      "SC2 Tools Agent v0.16.3 needs to be turned on or installed",
    )).toBeTruthy();
    expect(screen.queryByText(/keep replay syncing/i)).toBeNull();
    expect(screen.getByLabelText("Required agent update").className)
      .not.toContain("hidden");
  });

  it("uses the live latest release instead of the bundled fallback", () => {
    useReleaseInfoMock.mockReturnValue({
      data: { latest: "0.17.4" },
      isLoading: false,
      error: null,
    });
    useApiMock.mockReturnValue({ data: { items: [] }, isLoading: false });
    render(
      <AgentUpgradeNotice
        initialAgent={{ paired: false, version: null, lastSeenAt: null }}
      />,
    );

    expect(screen.getByText(
      "SC2 Tools Agent v0.17.4 needs to be turned on or installed",
    )).toBeTruthy();
  });
});
