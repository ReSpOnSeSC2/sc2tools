import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  requestedPaths: [] as Array<string | null>,
  rosterData: undefined as unknown,
  sharingData: undefined as unknown,
  assignmentsData: undefined as unknown,
  observedGamesByPath: {} as Record<string, unknown>,
  mutateRoster: vi.fn(async () => undefined),
  mutateAssignments: vi.fn(async () => undefined),
  mutateSharing: vi.fn(async () => undefined),
  mutateObservedGames: vi.fn(async () => undefined),
  apiCall: vi.fn(async () => ({})),
  getToken: vi.fn(async () => "test-token"),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
  useApi: (path: string | null) => {
    harness.requestedPaths.push(path);
    if (path === "/v1/coaching/state") {
      return {
        data: harness.rosterData,
        error: undefined,
        isLoading: false,
        mutate: harness.mutateRoster,
      };
    }
    if (path === "/v1/coaching/practice-sharing") {
      return {
        data: harness.sharingData,
        error: undefined,
        isLoading: false,
        mutate: harness.mutateSharing,
      };
    }
    if (path === "/v1/coaching/assignments" || path?.startsWith("/v1/coaching/assignments?")) {
      return {
        data: harness.assignmentsData,
        error: undefined,
        isLoading: false,
        mutate: harness.mutateAssignments,
      };
    }
    if (path && path in harness.observedGamesByPath) {
      return {
        data: harness.observedGamesByPath[path],
        error: undefined,
        isLoading: false,
        mutate: harness.mutateObservedGames,
      };
    }
    return {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: harness.mutateObservedGames,
    };
  },
}));

vi.mock("@/lib/useUserSocket", () => ({
  useUserSocket: vi.fn(),
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: harness.toast }),
}));

vi.mock("@/components/analyzer/ReplayDownloadButton", () => ({
  ReplayDownloadButton: ({
    gameId,
    available,
    downloadPath,
  }: {
    gameId: string;
    available: boolean;
    downloadPath?: string;
  }) => (
    <button
      type="button"
      data-testid={`replay-${gameId}`}
      data-download-path={downloadPath}
      disabled={!available}
    >
      {available ? "Download replay" : "Replay unavailable"}
    </button>
  ),
}));

vi.mock("./coachingTime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./coachingTime")>();
  return {
    ...actual,
    useLocalTimeZone: () => "UTC",
  };
});

import CoachingPractice from "./CoachingPractice";

beforeEach(() => {
  harness.requestedPaths.length = 0;
  harness.rosterData = { state: { students: [] } };
  harness.sharingData = sharingPayload("accepted");
  harness.assignmentsData = assignmentPayload([]);
  harness.observedGamesByPath = {};
  vi.clearAllMocks();
  harness.apiCall.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.style.overflow = "";
});

describe("CoachingPractice", () => {
  it("renders a student's nested assignment and never requests the coach roster", () => {
    harness.observedGamesByPath = {
      "/v1/coaching/assignments/assignment-1/games?page=1&limit=25": {
        assignmentId: "assignment-1",
        page: 1,
        limit: 25,
        total: 1,
        hasMore: false,
        games: [makeReplayGame()],
      },
    };
    harness.assignmentsData = assignmentPayload([
      makeAssignment({
        requirement: {
          type: "build",
          requiredGames: 5,
          recurrence: "once",
          build: { id: "pvp-oracle", name: "Oracle opener", matchBy: "name" },
          timeZone: "UTC",
          title: "Oracle mechanics",
          note: "Keep the first Oracle active.",
          window: assignmentWindow(),
        },
        progress: makeProgress({
          playedGames: 2,
          requiredGamesTotal: 5,
          currentBucket: makeBucket({ playedGames: 2, requiredGames: 5 }),
          buckets: [makeBucket({ playedGames: 2, requiredGames: 5 })],
          games: [makeReplayGame()],
          replayGames: [makeReplayGame()],
        }),
      }),
    ]);

    render(<CoachingPractice role="student" />);

    const replayList = screen.getByText("Games and replay evidence").closest("details");
    if (!replayList) throw new Error("Replay evidence details missing");
    replayList.open = true;
    fireEvent(replayList, new Event("toggle"));

    expect(harness.requestedPaths).toContain("/v1/coaching/assignments?page=1&limit=20");
    expect(harness.requestedPaths).not.toContain("/v1/coaching/state");
    expect(screen.getByText("Oracle mechanics")).toBeTruthy();
    expect(screen.getByText("Keep the first Oracle active.")).toBeTruthy();
    expect(screen.getByText("Golden Aura LE · vs Rival")).toBeTruthy();
    expect(screen.getByText(/Oracle opener · 1v1$/)).toBeTruthy();
    expect(screen.queryByText(/Ladder 1v1/)).toBeNull();
    expect(screen.queryByText(/Custom 1v1/)).toBeNull();

    const progress = screen.getByRole("progressbar", {
      name: "Oracle mechanics: 2 of 5 games",
    });
    expect(progress.getAttribute("aria-valuemin")).toBe("0");
    expect(progress.getAttribute("aria-valuemax")).toBe("5");
    expect(progress.getAttribute("aria-valuenow")).toBe("2");

    const replay = screen.getByTestId("replay-game-1");
    expect(replay.getAttribute("data-download-path")).toBe(
      "/v1/coaching/assignments/assignment-1/games/game-1/replay-download",
    );
  });

  it("uses an observed build's backend id when a coach creates a build plan", async () => {
    harness.rosterData = {
      state: {
        students: [{ id: "student-linked", name: "Aster", userId: "user-linked" }],
      },
    };
    harness.observedGamesByPath = {
      "/v1/coaching/students/user-linked/games": {
        games: [{ b: "Blink Timing", bid: "pvp-blink-timing-v3" }],
      },
    };
    harness.sharingData = sharingPayload("accepted", {
      student: { id: "student-linked", name: "Aster" },
    });

    render(<CoachingPractice role="coach" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Assign games" })[0]);

    const buildSelect = await screen.findByRole("combobox", { name: "Build" });
    fireEvent.change(buildSelect, { target: { value: "slug:pvp-blink-timing-v3" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Player's time zone" }), {
      target: { value: "UTC" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Assign plan" }));

    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(1));
    const [path, request] = harness.apiCall.mock.calls[0].slice(1) as unknown as [
      string,
      { method: string; body: string },
    ];
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(harness.requestedPaths).toContain(
      "/v1/coaching/students/user-linked/games",
    );
    expect(path).toBe("/v1/coaching/students/student-linked/assignments");
    expect(request.method).toBe("POST");
    expect(body).toMatchObject({
      type: "build",
      requiredGames: 5,
      build: {
        id: "pvp-blink-timing-v3",
        name: "Blink Timing",
        matchBy: "slug",
      },
      recurrence: "once",
      timeZone: "UTC",
    });
    expect(typeof body.clientRequestId).toBe("string");
    expect(typeof body.startsOn).toBe("string");
    expect(typeof body.endsOn).toBe("string");
  });

  it("keeps keyboard focus in the field while the assignment draft updates", async () => {
    harness.rosterData = {
      state: {
        students: [{ id: "student-linked", name: "Aster", userId: "user-linked" }],
      },
    };
    harness.sharingData = sharingPayload("accepted", {
      student: { id: "student-linked", name: "Aster" },
    });

    render(<CoachingPractice role="coach" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Assign games" })[0]);

    const input = await screen.findByRole("textbox", { name: "Exact detected style name" });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    input.focus();
    fireEvent.change(input, { target: { value: "PvP - Phoenix Style" } });
    await new Promise((resolve) => window.setTimeout(resolve, 5));

    expect(document.activeElement).toBe(input);
  });

  it("aligns the first weekly target once and preserves the coach's edited range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    harness.rosterData = {
      state: {
        students: [{ id: "student-linked", name: "Aster", userId: "user-linked" }],
      },
    };
    harness.sharingData = sharingPayload("accepted", {
      student: { id: "student-linked", name: "Aster" },
    });

    render(<CoachingPractice role="coach" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Assign games" })[0]);
    const starts = screen.getByLabelText("Starts");
    const ends = screen.getByLabelText("Ends");
    fireEvent.click(screen.getByRole("button", { name: /Total 1v1 games/ }));

    expect((starts as HTMLInputElement).value).toBe("2026-08-31");
    expect((ends as HTMLInputElement).value).toBe("2026-09-06");

    fireEvent.change(starts, { target: { value: "2026-09-01" } });
    fireEvent.change(ends, { target: { value: "2026-09-30" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Repeat target" }), {
      target: { value: "monthly" },
    });
    fireEvent.click(screen.getByRole("button", { name: /A specific build/ }));
    fireEvent.click(screen.getByRole("button", { name: /Total 1v1 games/ }));

    expect((starts as HTMLInputElement).value).toBe("2026-09-01");
    expect((ends as HTMLInputElement).value).toBe("2026-09-30");
  });

  it("re-anchors untouched weekly defaults in the selected player's time zone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T00:30:00.000Z"));
    harness.rosterData = {
      state: {
        students: [{ id: "student-linked", name: "Aster", userId: "user-linked" }],
      },
    };
    harness.sharingData = sharingPayload("accepted", {
      student: { id: "student-linked", name: "Aster" },
    });

    render(<CoachingPractice role="coach" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Assign games" })[0]);
    fireEvent.click(screen.getByRole("button", { name: /Total 1v1 games/ }));

    const starts = screen.getByLabelText("Starts") as HTMLInputElement;
    const ends = screen.getByLabelText("Ends") as HTMLInputElement;
    expect(starts.value).toBe("2026-09-07");
    expect(ends.value).toBe("2026-09-13");

    fireEvent.change(screen.getByRole("combobox", { name: "Player's time zone" }), {
      target: { value: "America/New_York" },
    });

    expect(starts.value).toBe("2026-08-31");
    expect(ends.value).toBe("2026-09-06");
  });

  it("preserves a coach-edited range when the player's time zone changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T00:30:00.000Z"));
    harness.rosterData = {
      state: {
        students: [{ id: "student-linked", name: "Aster", userId: "user-linked" }],
      },
    };
    harness.sharingData = sharingPayload("accepted", {
      student: { id: "student-linked", name: "Aster" },
    });

    render(<CoachingPractice role="coach" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Assign games" })[0]);
    fireEvent.click(screen.getByRole("button", { name: /Total 1v1 games/ }));

    const starts = screen.getByLabelText("Starts") as HTMLInputElement;
    const ends = screen.getByLabelText("Ends") as HTMLInputElement;
    fireEvent.change(starts, { target: { value: "2026-10-05" } });
    fireEvent.change(ends, { target: { value: "2026-10-18" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Player's time zone" }), {
      target: { value: "America/New_York" },
    });

    expect(starts.value).toBe("2026-10-05");
    expect(ends.value).toBe("2026-10-18");
  });

  it("does not let a coach assign games to an unlinked student", () => {
    harness.rosterData = {
      state: {
        students: [{ id: "student-unlinked", name: "Nova", userId: null }],
      },
    };

    render(<CoachingPractice role="coach" />);

    const assignButtons = screen.getAllByRole("button", { name: "Assign games" });
    expect(assignButtons.length).toBeGreaterThan(0);
    for (const button of assignButtons) {
      expect(button.hasAttribute("disabled")).toBe(true);
      fireEvent.click(button);
    }
    expect(screen.getByText(/Link this student's SC2 Tools account in Locker/)).toBeTruthy();
    expect(harness.apiCall).not.toHaveBeenCalled();
  });

  it("clears a selected build when the coach switches students in the modal", async () => {
    harness.rosterData = {
      state: {
        students: [
          { id: "student-a", name: "Aster", userId: "user-a" },
          { id: "student-b", name: "Blair", userId: "user-b" },
        ],
      },
    };
    harness.observedGamesByPath = {
      "/v1/coaching/students/user-a/games": {
        games: [{ b: "Blink Timing", bid: "pvp-blink-timing-v3" }],
      },
      "/v1/coaching/students/user-b/games": { games: [] },
    };
    harness.sharingData = {
      rev: 1,
      relationships: [
        sharingRelationship("accepted", { student: { id: "student-a", name: "Aster" } }),
        sharingRelationship("accepted", { student: { id: "student-b", name: "Blair" } }),
      ],
    };

    render(<CoachingPractice role="coach" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Assign games" })[0]);

    const buildSelect = await screen.findByRole("combobox", { name: "Build" });
    fireEvent.change(buildSelect, { target: { value: "slug:pvp-blink-timing-v3" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Student" }), {
      target: { value: "student-b" },
    });

    expect((buildSelect as HTMLSelectElement).value).toBe("manual");
    expect((screen.getByPlaceholderText("e.g. PvP - Phoenix Style") as HTMLInputElement).value).toBe("");
    expect(harness.requestedPaths).toContain("/v1/coaching/students/user-b/games");
  });

  it("lets a student explicitly accept a pending practice-replay request", async () => {
    harness.sharingData = sharingPayload("pending");

    render(<CoachingPractice role="student" />);
    fireEvent.click(screen.getByRole("button", { name: "Allow sharing" }));

    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(1));
    expect(harness.apiCall.mock.calls[0].slice(1)).toEqual([
      "/v1/coaching/practice-sharing/respond",
      {
        method: "POST",
        body: JSON.stringify({
          expectedRev: 1,
          coachId: "coach-1",
          decision: "accepted",
        }),
      },
    ]);
  });

  it("lets a coach request approval but keeps assignment creation disabled", async () => {
    harness.rosterData = {
      state: {
        students: [{ id: "student-linked", name: "Aster", userId: "user-linked" }],
      },
    };
    harness.sharingData = sharingPayload("revoked", {
      student: { id: "student-linked", name: "Aster" },
      revokedAt: "2026-09-04T12:00:00.000Z",
    });

    render(<CoachingPractice role="coach" />);

    for (const button of screen.getAllByRole("button", { name: "Assign games" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(button.getAttribute("title")).toMatch(/approve practice and replay sharing/i);
    }
    fireEvent.click(screen.getByRole("button", { name: "Request approval" }));

    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(1));
    expect(harness.apiCall.mock.calls[0].slice(1)).toEqual([
      "/v1/coaching/students/student-linked/practice-sharing/request",
      { method: "POST", body: JSON.stringify({ expectedRev: 1 }) },
    ]);
  });

  it("pages older practice plans instead of silently capping history", () => {
    harness.assignmentsData = {
      ...assignmentPayload([makeAssignment()]),
      page: 1,
      limit: 20,
      hasMore: true,
    };

    render(<CoachingPractice role="student" />);
    fireEvent.click(screen.getByRole("button", { name: "Older plans" }));

    expect(harness.requestedPaths).toContain("/v1/coaching/assignments?page=2&limit=20");
  });

  it("shows the final empty bucket for an ended recurring plan", () => {
    const first = makeBucket({
      key: "2026-08-31",
      startsAt: "2026-08-31T00:00:00.000Z",
      endsAt: "2026-09-01T00:00:00.000Z",
      playedGames: 4,
      requiredGames: 4,
      complete: true,
    });
    const last = makeBucket({
      key: "2026-09-01",
      startsAt: "2026-09-01T00:00:00.000Z",
      endsAt: "2026-09-02T00:00:00.000Z",
      playedGames: 0,
      requiredGames: 4,
      complete: false,
    });
    harness.assignmentsData = assignmentPayload([
      makeAssignment({
        requirement: {
          type: "total",
          requiredGames: 4,
          recurrence: "daily",
          build: null,
          timeZone: "UTC",
          title: null,
          note: null,
          window: assignmentWindow(),
        },
        progress: makeProgress({
          state: "missed",
          playedGames: 4,
          requiredGamesTotal: 8,
          completedBuckets: 1,
          totalBuckets: 2,
          currentBucket: null,
          buckets: [first, last],
        }),
      }),
    ]);

    render(<CoachingPractice role="student" />);

    const progress = screen.getByRole("progressbar", {
      name: "4 games per day: 0 of 4 games",
    });
    expect(progress.getAttribute("aria-valuenow")).toBe("0");
    expect(progress.getAttribute("aria-valuemax")).toBe("4");
    expect(screen.getByText("4 to go")).toBeTruthy();
  });

  it("does not label an empty cancelled plan as target reached", () => {
    harness.assignmentsData = assignmentPayload([
      makeAssignment({
        status: "cancelled",
        progress: makeProgress({
          state: "cancelled",
          playedGames: 0,
          requiredGamesTotal: 0,
          completedBuckets: 0,
          totalBuckets: 0,
          currentBucket: null,
          buckets: [],
        }),
      }),
    ]);

    render(<CoachingPractice role="student" />);

    expect(screen.getByRole("progressbar", {
      name: "5 Oracle opener games: 0 of 5 games",
    })).toBeTruthy();
    expect(screen.getByText("No games counted")).toBeTruthy();
    expect(screen.queryByText("Target reached")).toBeNull();
  });
});

function assignmentPayload(assignments: unknown[]) {
  return {
    serverTime: "2026-09-04T12:00:00.000Z",
    assignments,
  };
}

function sharingPayload(status: string, overrides: Record<string, unknown> = {}) {
  return {
    rev: 1,
    relationships: [sharingRelationship(status, overrides)],
  };
}

function sharingRelationship(status: string, overrides: Record<string, unknown> = {}) {
  return {
    student: { id: "student-1", name: "Aster" },
    coach: { id: "coach-1", name: "Coach" },
    status,
    requestedAt: status === "pending" ? "2026-09-04T12:00:00.000Z" : null,
    respondedAt: status === "accepted" ? "2026-09-04T12:00:00.000Z" : null,
    revokedAt: null,
    policyVersion: "practice-replays-v1",
    scope: {
      practiceAssignments: true,
      qualifyingOneVsOneGameDetails: true,
      archivedOriginalReplays: true,
    },
    ...overrides,
  };
}

function assignmentWindow() {
  return {
    startsOn: "2026-09-01",
    endsOn: "2026-09-07",
    startsAt: "2026-09-01T00:00:00.000Z",
    endsAt: "2026-09-08T00:00:00.000Z",
    endExclusive: true as const,
  };
}

function makeAssignment(overrides: Record<string, unknown> = {}) {
  return {
    id: "assignment-1",
    rev: 1,
    status: "active",
    student: { id: "student-1", name: "Aster" },
    coach: { id: "coach-1", name: "Coach" },
    requirement: {
      type: "build",
      requiredGames: 5,
      recurrence: "once",
      build: { id: "pvp-oracle", name: "Oracle opener", matchBy: "name" },
      timeZone: "UTC",
      title: null,
      note: null,
      window: assignmentWindow(),
    },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
    progress: makeProgress(),
    ...overrides,
  };
}

function makeProgress(overrides: Record<string, unknown> = {}) {
  return {
    state: "active",
    playedGames: 0,
    requiredGamesTotal: 5,
    completedBuckets: 0,
    totalBuckets: 1,
    currentBucket: makeBucket(),
    buckets: [makeBucket()],
    games: [],
    replayGames: [],
    replayGameCount: 0,
    gamesTruncated: false,
    ...overrides,
  };
}

function makeBucket(overrides: Record<string, unknown> = {}) {
  const playedGames = typeof overrides.playedGames === "number" ? overrides.playedGames : 0;
  const requiredGames = typeof overrides.requiredGames === "number" ? overrides.requiredGames : 5;
  return {
    key: "2026-09-01",
    startsAt: "2026-09-01T00:00:00.000Z",
    endsAt: "2026-09-08T00:00:00.000Z",
    playedGames,
    requiredGames,
    remainingGames: Math.max(0, requiredGames - playedGames),
    complete: playedGames >= requiredGames,
    ...overrides,
  };
}

function makeReplayGame() {
  return {
    gameId: "game-1",
    date: "2026-09-03T18:30:00.000Z",
    map: "Golden Aura LE",
    opponent: "Rival",
    result: "Victory",
    myBuild: "Oracle opener",
    isLadderGame: null,
    matchFormat: "1v1",
    replayAvailable: true,
    replayDownloadPath: "/ignored-owner-route",
  };
}
