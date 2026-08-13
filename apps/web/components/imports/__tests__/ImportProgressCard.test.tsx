import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImportProgressCard } from "../ImportProgressCard";
import type { ImportJob } from "../useImportStatus";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn() }),
}));

afterEach(cleanup);

function job(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    jobId: "job-1",
    kind: "history",
    status: "done",
    phase: "import",
    folder: null,
    total: 6,
    completed: 5,
    errors: 1,
    remaining: 0,
    workers: 1,
    startedAt: "2026-08-10T00:00:00.000Z",
    finishedAt: "2026-08-10T00:01:00.000Z",
    lastMessage: "",
    errorBreakdown: {
      ai_game: 3,
      resumed_replay: 2,
      parse_failed: 1,
    },
    errorSamples: [
      { file: "resume-artifact.SC2Replay", errorCode: "resumed_replay" },
      { file: "broken.SC2Replay", errorCode: "parse_failed" },
    ],
    ...overrides,
  };
}

describe("ImportProgressCard benign replay-resume skips", () => {
  it("shows them as intentional skips and omits them from failure details", () => {
    render(
      <ImportProgressCard
        job={job()}
        active={false}
        pct={100}
        etaSeconds={null}
      />,
    );

    expect(screen.getByText("vs AI skipped: 3")).toBeTruthy();
    expect(screen.getByText("accepted: 0")).toBeTruthy();
    expect(screen.getByText("remaining: 0")).toBeTruthy();
    expect(
      screen.getByText("replay-resume sessions skipped: 2"),
    ).toBeTruthy();
    expect(screen.getByText(/0 replay files accepted/i)).toBeTruthy();

    const failures = screen.getByRole("button", {
      name: /1 file couldn't be imported/i,
    });
    fireEvent.click(failures);

    expect(screen.getByText(/1× parse failed/i)).toBeTruthy();
    expect(screen.getByText(/broken\.SC2Replay/i)).toBeTruthy();
    expect(screen.queryByText(/2× resumed replay/i)).toBeNull();
    expect(screen.queryByText(/resume-artifact\.SC2Replay/i)).toBeNull();
  });

  it("renders a stalled backlog as unfinished background sync", () => {
    render(
      <ImportProgressCard
        job={job({
          status: "stalled",
          total: 100,
          completed: 20,
          errors: 1,
          remaining: 79,
          finishedAt: null,
          errorBreakdown: null,
          errorSamples: null,
        })}
        active={false}
        pct={21}
        etaSeconds={999}
      />,
    );

    expect(screen.getByText("Background sync continuing")).toBeTruthy();
    expect(screen.getByText(/21 \/ 100 replay files checked/i)).toBeTruthy();
    expect(screen.getByText("accepted: 20")).toBeTruthy();
    expect(screen.getByText("remaining: 79")).toBeTruthy();
    expect(screen.getByText(/79 replay files remain/i)).toBeTruthy();
    expect(screen.getByText(/rate-limited files are not counted as accepted/i)).toBeTruthy();
    expect(screen.queryByText("Import complete")).toBeNull();
    expect(screen.queryByText(/left$/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("does not count date-filtered files as accepted", () => {
    render(
      <ImportProgressCard
        job={job({
          total: 3,
          completed: 3,
          errors: 0,
          remaining: 0,
          errorBreakdown: { filtered: 2 },
          errorSamples: null,
        })}
        active={false}
        pct={100}
        etaSeconds={null}
      />,
    );

    expect(screen.getByText("accepted: 1")).toBeTruthy();
    expect(screen.getByText("outside date range skipped: 2")).toBeTruthy();
  });
});
