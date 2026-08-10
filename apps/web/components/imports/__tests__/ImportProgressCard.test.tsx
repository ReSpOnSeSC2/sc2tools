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
    expect(screen.getByText("imported: 0")).toBeTruthy();
    expect(
      screen.getByText("replay-resume sessions skipped: 2"),
    ).toBeTruthy();
    expect(screen.getByText(/0 replays imported/i)).toBeTruthy();

    const failures = screen.getByRole("button", {
      name: /1 file couldn't be imported/i,
    });
    fireEvent.click(failures);

    expect(screen.getByText(/1× parse failed/i)).toBeTruthy();
    expect(screen.getByText(/broken\.SC2Replay/i)).toBeTruthy();
    expect(screen.queryByText(/2× resumed replay/i)).toBeNull();
    expect(screen.queryByText(/resume-artifact\.SC2Replay/i)).toBeNull();
  });
});
