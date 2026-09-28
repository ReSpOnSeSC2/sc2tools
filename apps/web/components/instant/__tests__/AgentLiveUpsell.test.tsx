/**
 * AgentLiveUpsell + ImportSummary — honest copy, the /download link, a
 * remembered dismissal, and summary rows that hide at zero. useApi and
 * the instant flag are mocked for the overlay gate.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_LIVE_FEATURES, AgentLiveUpsell, OverlayAgentUpsell } from "../AgentLiveUpsell";
import { ImportSummary, summaryRows } from "../ImportSummary";

const mocks = vi.hoisted(() => ({ enabled: true, agentPaired: false as boolean | undefined }));
vi.mock("@/lib/instant/useInstantImport", () => ({
  useInstantImport: () => ({ enabled: mocks.enabled, mode: "all", loading: false }),
}));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string | null) => ({ data: path ? { agentPaired: mocks.agentPaired } : undefined }),
}));

const KEY = "sc2tools.test.upsell";

beforeEach(() => {
  window.localStorage.clear();
  mocks.enabled = true;
  mocks.agentPaired = false;
});

afterEach(cleanup);

describe("AgentLiveUpsell", () => {
  it("lists what only the agent can do and links to the download", () => {
    render(<AgentLiveUpsell variant="card" />);
    expect(screen.getByRole("heading", { name: "Install the agent for live features" })).toBeTruthy();
    for (const feature of AGENT_LIVE_FEATURES) expect(screen.getByText(feature.title)).toBeTruthy();
    expect(screen.getByText(/localhost:6119/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /get the desktop agent/i }).getAttribute("href")).toBe("/download");
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
  });

  it("leaves localStorage alone when it cannot be dismissed", async () => {
    window.localStorage.clear();
    await act(async () => {
      render(<AgentLiveUpsell variant="card" />);
    });
    expect(window.localStorage.length).toBe(0);
  });

  it("remembers a dismissal", async () => {
    render(<AgentLiveUpsell variant="inline" dismissKey={KEY} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the agent suggestion" }));
    expect(screen.queryByText("Install the agent for live features")).toBeNull();
    cleanup();
    await act(async () => {
      render(<AgentLiveUpsell variant="inline" dismissKey={KEY} />);
    });
    expect(screen.queryByText("Install the agent for live features")).toBeNull();
  });

  it("shows the overlay card only for enabled accounts without a paired agent", () => {
    render(<OverlayAgentUpsell />);
    expect(screen.getByText("Install the agent for live features")).toBeTruthy();
    cleanup();
    mocks.agentPaired = true;
    render(<OverlayAgentUpsell />);
    expect(screen.queryByText("Install the agent for live features")).toBeNull();
    cleanup();
    mocks.agentPaired = false;
    mocks.enabled = false;
    render(<OverlayAgentUpsell />);
    expect(screen.queryByText("Install the agent for live features")).toBeNull();
  });
});

describe("ImportSummary", () => {
  it("hides zero rows", () => {
    expect(summaryRows({ uploaded: 3, created: 2, skippedExisting: 0, rejected: 0, pending: 0 })).toEqual([
      { label: "Added to your account", value: 2 },
      { label: "Updated", value: 1 },
    ]);
  });

  it("explains an expired session and groups failures by kind", () => {
    const failure = { ok: false as const, fileName: "x.SC2Replay", relativePath: "x.SC2Replay", ms: 1 };
    render(
      <ImportSummary
        counts={{ uploaded: 0, created: 0, skippedExisting: 0, rejected: 0, pending: 4, stoppedReason: "auth" }}
        failed={[{ ...failure, errorKind: "ai_game" }, { ...failure, errorKind: "ai_game" }]}
      />,
    );
    expect(screen.getByText("Your session expired")).toBeTruthy();
    expect(screen.getByText("Not uploaded yet")).toBeTruthy();
    expect(screen.getByText(/Games vs the AI/)).toBeTruthy();
    expect(screen.queryByText("x.SC2Replay")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open your dashboard" })).toBeNull();
  });

  it("says when the original-file backup stopped because the visitor cancelled", () => {
    render(
      <ImportSummary
        counts={{ uploaded: 2, created: 2, skippedExisting: 0, rejected: 0, pending: 0 }}
        failed={[]}
        backup={{ backedUp: ["g1"], alreadyStored: [], skipped: [], failed: [], stoppedReason: "aborted" }}
      />,
    );
    expect(screen.getByText("Original replay files: 1 backed up, stopped when you cancelled.")).toBeTruthy();
  });
});
