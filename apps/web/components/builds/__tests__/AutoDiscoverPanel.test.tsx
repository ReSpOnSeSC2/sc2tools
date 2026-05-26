import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AutoApplyResult, AutoCandidate } from "../types";

/**
 * Tests for the AutoDiscoverPanel apply flow.
 *
 * Verifies:
 *   - Per-card "Create" optimistically removes the card before the
 *     request resolves, then leaves it removed on success.
 *   - On failure the card is restored and an error toast fires.
 *   - "Create all" submits every visible candidate in a single batch
 *     and clears the panel.
 *   - The parent's onApplied callback receives the created slugs so it
 *     can revalidate the build library + stats SWR caches.
 *
 * The Clerk auth hook and the SWR-backed useAutoCandidates hook are
 * both mocked so the test never touches the network. applyAutoCandidates
 * is replaced with a controllable deferred so we can assert UI state
 * during the in-flight window.
 */

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: true,
    getToken: async () => "test-token",
  }),
}));

const mutateMock = vi.fn(async () => undefined);
const useAutoCandidatesMock = vi.fn();
const applyAutoCandidatesMock = vi.fn();

vi.mock("@/lib/autoClassifyApi", () => ({
  useAutoCandidates: (perspective: "you" | "opponent") =>
    useAutoCandidatesMock(perspective),
  applyAutoCandidates: (
    getToken: () => Promise<string | null>,
    candidates: AutoCandidate[],
  ) => applyAutoCandidatesMock(getToken, candidates),
}));

import { ToastProvider } from "@/components/ui/Toast";
import { AutoDiscoverPanel } from "../AutoDiscoverPanel";

function makeCandidate(over: Partial<AutoCandidate> = {}): AutoCandidate {
  return {
    matchup: "PvZ",
    perspective: "you",
    proposedName: "PvZ - Stargate Phoenix Discovery",
    proposedSlug: "pvz-stargate-phoenix-discovery",
    race: "Protoss",
    vsRace: "Zerg",
    rules: [{ type: "before", name: "BuildStargate", time_lt: 210 }],
    gameCount: 6,
    winRate: 0.66,
    cohesion: 0.81,
    selfMatchRate: 0.9,
    sampleGames: [],
    ...over,
  };
}

function makeApplyResult(over: Partial<AutoApplyResult> = {}): AutoApplyResult {
  return {
    ok: true,
    created: ["pvz-stargate-phoenix-discovery"],
    builds: 1,
    scanned: 6,
    tagged: 6,
    cleared: 0,
    perBuild: [],
    ...over,
  };
}

function renderPanel(
  props: { onApplied?: (s: string[]) => void | Promise<void> } = {},
) {
  return render(
    <ToastProvider>
      <AutoDiscoverPanel onApplied={props.onApplied} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  mutateMock.mockReset();
  mutateMock.mockResolvedValue(undefined);
  useAutoCandidatesMock.mockReset();
  applyAutoCandidatesMock.mockReset();
});

afterEach(cleanup);

describe("AutoDiscoverPanel", () => {
  it("optimistically removes the card before applyAutoCandidates resolves", async () => {
    const candidate = makeCandidate();
    useAutoCandidatesMock.mockReturnValue({
      data: { perspective: "you", candidates: [candidate] },
      candidates: [candidate],
      isLoading: false,
      error: undefined,
      mutate: mutateMock,
    });

    let resolveApply: ((res: AutoApplyResult) => void) | null = null;
    applyAutoCandidatesMock.mockImplementation(
      () =>
        new Promise<AutoApplyResult>((r) => {
          resolveApply = r;
        }),
    );

    renderPanel();

    expect(
      screen.getByRole("heading", {
        name: /PvZ - Stargate Phoenix Discovery/i,
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Create build/i }));

    // Card is gone immediately — before the apply promise settles.
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: /PvZ - Stargate Phoenix Discovery/i,
        }),
      ).toBeNull();
    });
    expect(applyAutoCandidatesMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveApply?.(makeApplyResult());
    });
    await waitFor(() => expect(mutateMock).toHaveBeenCalled());
  });

  it("rolls back when applyAutoCandidates rejects, restoring the card and surfacing details", async () => {
    const candidate = makeCandidate();
    useAutoCandidatesMock.mockReturnValue({
      data: { perspective: "you", candidates: [candidate] },
      candidates: [candidate],
      isLoading: false,
      error: undefined,
      mutate: mutateMock,
    });

    applyAutoCandidatesMock.mockRejectedValue({
      status: 400,
      code: "invalid_candidates",
      message: "Request failed (HTTP 400).",
      details: ["candidates[0].name must match ^[A-Za-z][A-Za-z0-9]*$"],
    });

    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Create build/i }));
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          name: /PvZ - Stargate Phoenix Discovery/i,
        }),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(/candidates\[0\]\.name must match/i),
    ).toBeTruthy();
    // No SWR revalidation should fire on the failure path — the
    // optimistic hide was rolled back instead.
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("Create all batches every visible candidate into one apply call", async () => {
    const a = makeCandidate({
      proposedName: "PvZ - Stargate",
      proposedSlug: "pvz-stargate",
    });
    const b = makeCandidate({
      proposedName: "PvT - Glaive Adept",
      proposedSlug: "pvt-glaive-adept",
      matchup: "PvT",
      vsRace: "Terran",
    });
    useAutoCandidatesMock.mockReturnValue({
      data: { perspective: "you", candidates: [a, b] },
      candidates: [a, b],
      isLoading: false,
      error: undefined,
      mutate: mutateMock,
    });

    applyAutoCandidatesMock.mockResolvedValue(
      makeApplyResult({
        created: ["pvz-stargate", "pvt-glaive-adept"],
        builds: 2,
        tagged: 12,
      }),
    );

    const onApplied = vi.fn();
    renderPanel({ onApplied });

    const createAll = screen.getByRole("button", {
      name: /Create all 2 discovered builds/i,
    });
    expect(createAll.className).toMatch(/min-h-\[44px\]/);

    await act(async () => {
      fireEvent.click(createAll);
    });

    await waitFor(() => {
      expect(applyAutoCandidatesMock).toHaveBeenCalledTimes(1);
    });
    const [, batch] = applyAutoCandidatesMock.mock.calls[0] as [
      unknown,
      AutoCandidate[],
    ];
    expect(batch.map((c) => c.proposedSlug)).toEqual([
      "pvz-stargate",
      "pvt-glaive-adept",
    ]);
    await waitFor(() => {
      expect(onApplied).toHaveBeenCalledWith([
        "pvz-stargate",
        "pvt-glaive-adept",
      ]);
    });
    expect(
      screen.queryByRole("heading", { name: /PvZ - Stargate/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: /PvT - Glaive Adept/i }),
    ).toBeNull();
  });

  it("guards against double-submit while a create is in flight", async () => {
    const candidate = makeCandidate();
    useAutoCandidatesMock.mockReturnValue({
      data: { perspective: "you", candidates: [candidate] },
      candidates: [candidate],
      isLoading: false,
      error: undefined,
      mutate: mutateMock,
    });

    let resolveApply: ((res: AutoApplyResult) => void) | null = null;
    applyAutoCandidatesMock.mockImplementation(
      () =>
        new Promise<AutoApplyResult>((r) => {
          resolveApply = r;
        }),
    );

    renderPanel();

    const createBtn = screen.getByRole("button", { name: /Create build/i });
    fireEvent.click(createBtn);
    // Second click while the request is still pending must not fire
    // another apply — the optimistic hide already removed the card.
    fireEvent.click(createBtn);

    expect(applyAutoCandidatesMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveApply?.(makeApplyResult());
    });
  });
});
