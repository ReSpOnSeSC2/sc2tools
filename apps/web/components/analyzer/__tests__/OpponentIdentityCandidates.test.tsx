import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  useApi: vi.fn(),
  dbRev: 7,
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => harness.useApi(...args),
}));

vi.mock("@/lib/filterContext", () => ({
  useFilters: () => ({ dbRev: harness.dbRev }),
}));

import {
  OpponentIdentityCandidates,
  type IdentityCandidate,
  type OpponentIdentityCandidatesResponse,
} from "../OpponentIdentityCandidates";

function candidate(
  rank = 1,
  overrides: Partial<IdentityCandidate> = {},
): IdentityCandidate {
  return {
    rank,
    pulseId: rank === 1 ? "candidate/a" : `candidate-${rank}`,
    pulseCharacterId: String(100 + rank),
    name: rank === 1 ? "Clem" : `Player ${rank}`,
    race: "Terran",
    region: "EU",
    mmr: 6123 - rank,
    gamesInProfile: 18 + rank,
    likelihood: rank === 1 ? 0.42 : 0.2 / rank,
    patternMatch: rank === 1 ? 0.91 : 0.78 - rank * 0.02,
    confidence: rank === 1 ? "high" : "medium",
    evidenceQuality: rank === 1 ? 0.84 : 0.62,
    sample: {
      targetGames: 6,
      candidateGames: 12,
      targetEvidenceGames: 5,
      candidateEvidenceGames: 9,
    },
    evidence: {
      coverage: 1,
      buildOrders: {
        score: 0.86,
        targetSamples: 5,
        candidateSamples: 8,
        sharedBuilds: ["2-1-1", "Reaper expand"],
        sharedMilestones: [{ name: "Factory", deltaSec: 8 }],
        highlights: ["Shared builds: 2-1-1, Reaper expand"],
      },
      controlGroups: {
        score: 0.96,
        targetSamples: 4,
        candidateSamples: 7,
        matchedSlots: [1, 4],
        highlights: ["Similar control-group double-tap rhythm"],
      },
    },
    caveats: [],
    ...overrides,
  };
}

function response(
  overrides: Partial<OpponentIdentityCandidatesResponse> = {},
): OpponentIdentityCandidatesResponse {
  return {
    status: "ready",
    calibrated: false,
    methodologyVersion: "behavior_match_v1",
    generatedAt: "2026-09-01T14:00:00.000Z",
    eligibility: {
      eligible: true,
      isBarcode: true,
      pulseResolved: false,
      mmrPresent: false,
      reasons: ["pulse_unresolved", "mmr_missing"],
    },
    target: {
      pulseId: "barcode/target",
      name: "IIlIlI",
      race: "Terran",
      raceCode: "T",
      games: 6,
      buildGames: 5,
      controlGroupGames: 4,
      evidenceMode: "build_and_control_groups",
      matchup: "TvP",
    },
    candidates: [candidate()],
    unknownLikelihood: 0.32,
    otherLikelihood: 0.06,
    scope: {
      source: "your_replay_history",
      searchedOpponents: 24,
      searchedGames: 318,
      truncated: false,
    },
    ...overrides,
  };
}

function apiResult(
  data: OpponentIdentityCandidatesResponse | null = response(),
  overrides: Record<string, unknown> = {},
) {
  return {
    data: data ?? undefined,
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  harness.dbRev = 7;
  harness.useApi.mockReset();
  harness.useApi.mockReturnValue(apiResult());
});

afterEach(cleanup);

describe("OpponentIdentityCandidates", () => {
  it("does not fetch or render when identity matching is disabled", () => {
    const { container } = render(
      <OpponentIdentityCandidates
        pulseId="barcode/target"
        enabled={false}
        race="Terran"
      />,
    );

    expect(harness.useApi).toHaveBeenCalledWith(null, {
      revalidateOnFocus: false,
    });
    expect(container.firstChild).toBeNull();
  });

  it("uses an encoded, database-revision-scoped endpoint", () => {
    render(
      <OpponentIdentityCandidates
        pulseId="barcode/target"
        enabled
        race="Terran"
      />,
    );

    expect(harness.useApi).toHaveBeenCalledWith(
      "/v1/opponents/barcode%2Ftarget/identity-candidates#7",
      { revalidateOnFocus: false },
    );
  });

  it("renders ranked leads with separate scores, unknown, and outside-top-five mass", () => {
    render(
      <OpponentIdentityCandidates
        pulseId="barcode/target"
        enabled
        race="Terran"
      />,
    );

    expect(screen.getByText("Possible identity matches")).toBeTruthy();
    expect(screen.getByText("Experimental")).toBeTruthy();
    expect(screen.getByText("Unverified")).toBeTruthy();
    expect(screen.getByText("Terran only")).toBeTruthy();

    const row = screen.getByTestId("identity-candidate-row");
    expect(within(row).getByText("Clem")).toBeTruthy();
    expect(within(row).getByText("Estimated likelihood")).toBeTruthy();
    expect(within(row).getByText("42%")).toBeTruthy();
    expect(within(row).getByText("Pattern match")).toBeTruthy();
    expect(within(row).getByText("91%")).toBeTruthy();
    expect(
      within(row).getByRole("progressbar", {
        name: "Build-order pattern 86%",
      }),
    ).toBeTruthy();
    expect(
      within(row).getByRole("progressbar", {
        name: "Control-group habits 96%",
      }),
    ).toBeTruthy();

    const unknown = screen.getByLabelText("Unlisted identity likelihoods");
    expect(within(unknown).getByText("Unknown player")).toBeTruthy();
    expect(within(unknown).getByText("32%")).toBeTruthy();
    expect(within(unknown).getByText("Outside top five")).toBeTruthy();
    expect(
      within(unknown).getByLabelText(
        "6% likelihood across known candidates outside the top five",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Estimated likelihood is uncalibrated/i)).toBeTruthy();
    expect(screen.getByText(/no profile is linked automatically/i)).toBeTruthy();
  });

  it("expands detailed build and logical control-group evidence and links safely", () => {
    harness.useApi.mockReturnValue(
      apiResult(
        response({
          candidates: [
            candidate(1, {
              caveats: ["single_target_replay"],
            }),
          ],
        }),
      ),
    );
    render(
      <OpponentIdentityCandidates pulseId="target" enabled race="Terran" />,
    );

    const compare = screen.getByRole("button", { name: "Compare evidence" });
    expect(compare.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Shared builds")).toBeNull();

    fireEvent.click(compare);
    expect(compare.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Shared builds")).toBeTruthy();
    expect(screen.getByText("2-1-1")).toBeTruthy();
    expect(screen.getByText("Factory")).toBeTruthy();
    expect(screen.getByText("Group 1")).toBeTruthy();
    expect(screen.getByText("Group 4")).toBeTruthy();
    expect(
      screen.getByText(/Only one target replay contributed evidence/i),
    ).toBeTruthy();

    const dossier = screen.getByRole("link", {
      name: "Open Clem opponent dossier",
    });
    expect(dossier.getAttribute("href")).toBe(
      "/app/opponents/candidate%2Fa",
    );
  });

  it("bounds a malformed oversized response to five visible candidates", () => {
    harness.useApi.mockReturnValue(
      apiResult(
        response({
          candidates: Array.from({ length: 6 }, (_, index) =>
            candidate(index + 1),
          ),
        }),
      ),
    );
    render(<OpponentIdentityCandidates pulseId="target" enabled />);

    expect(screen.getAllByTestId("identity-candidate-row")).toHaveLength(5);
    expect(screen.queryByText("Player 6")).toBeNull();
  });

  it("shows the evidence assessment and separates label-only builds from detailed replay measurements", () => {
    const base = candidate();
    harness.useApi.mockReturnValue(apiResult(response({
      methodologyVersion: "behavior_match_v2",
      assessment: {
        status: "insufficient",
        reason: "The target needs repeated behavioral evidence.",
      },
      target: {
        ...response().target,
        games: 1,
        buildGames: 1,
        controlGroupGames: 1,
        advancedControlGroupGames: 1,
        actionGames: 1,
        signatureVersion: 2,
        evidenceMode: "behavioral",
      },
      candidates: [candidate(1, {
        evidence: {
          coverage: 0.8,
          buildOrders: {
            ...base.evidence.buildOrders!,
            score: 0.55,
            detailLevel: "labels_only",
            milestoneSamples: { target: 0, candidate: 0 },
            sharedMilestones: [],
          },
          controlGroups: {
            ...base.evidence.controlGroups!,
            advancedSamples: { target: 1, candidate: 3 },
            dimensions: [{
              key: "event_rate",
              label: "Control-group activity rate",
              score: 0.94,
              targetSamples: 1,
              candidateSamples: 3,
              targetValue: 34.6,
              candidateValue: 32.5,
              unit: "per_minute",
            }],
          },
          actions: {
            score: 0.72,
            targetSamples: 1,
            candidateSamples: 3,
            targetEvents: 1200,
            candidateEvents: 4500,
            consistency: { target: null, candidate: 0.89 },
            highlights: ["Similar action cadence"],
            dimensions: [{
              key: "command_rate",
              label: "Recorded command rate",
              score: 0.76,
              targetSamples: 1,
              candidateSamples: 3,
              targetValue: 115,
              candidateValue: 132,
              unit: "per_minute",
            }],
          },
        },
        caveats: ["labels_only_build_evidence", "sparse_action_events"],
      })],
    })));

    render(<OpponentIdentityCandidates pulseId="target" enabled />);

    expect(screen.getByLabelText("Identity evidence assessment").textContent)
      .toContain("Evidence is too limited to identify a player");
    expect(screen.getByText(/Only one target replay is available/)).toBeTruthy();
    expect(screen.getByText(/1 detailed control-group games/)).toBeTruthy();
    expect(screen.getByText("Build labels only · no comparable opening timings")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Replay-action habits 72%" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Compare evidence" }));

    const controls = screen.getByRole("table", { name: "Control-group measurements" });
    expect(within(controls).getByText("34.6/min")).toBeTruthy();
    expect(within(controls).getByText("32.5/min")).toBeTruthy();
    expect(within(controls).getByText("94%")).toBeTruthy();
    const actions = screen.getByRole("table", { name: "Replay-action measurements" });
    expect(within(actions).getByText("115/min")).toBeTruthy();
    expect(screen.getByText(/Recorded events: 1,200 target · 4,500 candidate/)).toBeTruthy();
    expect(screen.getByText(/target needs repeated games · candidate 89%/)).toBeTruthy();
    expect(screen.getByText(/Consistency of action mix across games/)).toBeTruthy();
    expect(screen.getByText(/Physical keystrokes,/)).toBeTruthy();
    expect(screen.getByText(/Only classified build labels can be compared/)).toBeTruthy();
    expect(screen.getByText(/Too few recorded actions/)).toBeTruthy();
  });

  it("keeps unavailable measurements distinct from zero similarity and exposes reprocessing gaps", () => {
    const base = candidate();
    harness.useApi.mockReturnValue(apiResult(response({
      target: { ...response().target, signatureVersion: 2 },
      candidates: [candidate(1, {
        evidence: {
          ...base.evidence,
          controlGroups: {
            ...base.evidence.controlGroups!,
            advancedSamples: { target: 0, candidate: 2 },
            dimensions: [{
              key: "phase_usage",
              label: "Usage by game phase",
              score: null,
              targetSamples: 0,
              candidateSamples: 2,
            }, {
              key: "double_tap",
              label: "Double-tap rhythm",
              score: 0,
              targetSamples: 4,
              candidateSamples: 7,
              targetValue: 0,
              candidateValue: 0.5,
              unit: "ratio",
            }],
          },
          actions: null,
        },
      })],
    })));
    render(<OpponentIdentityCandidates pulseId="target" enabled />);

    expect(screen.getByText("Replay-action habits")).toBeTruthy();
    expect(screen.queryByRole("progressbar", { name: /Replay-action habits/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Compare evidence" }));

    const table = screen.getByRole("table", { name: "Control-group measurements" });
    const missing = within(table).getByRole("rowheader", { name: "Usage by game phase" }).closest("tr")!;
    expect(within(missing).getByText("Unavailable")).toBeTruthy();
    expect(within(missing).getByText("No samples")).toBeTruthy();
    expect(within(missing).queryByText("0%")).toBeNull();
    const zero = within(table).getByRole("rowheader", { name: "Double-tap rhythm" }).closest("tr")!;
    expect(within(zero).getAllByText("0%")).toHaveLength(2);
    expect(within(zero).getByText("50%")).toBeTruthy();
    expect(screen.getByText(/Reprocess older replays to compare detailed timing/)).toBeTruthy();
    expect(screen.getByText("This evidence channel was not available for both profiles.")).toBeTruthy();
  });

  it("renders an ambiguous assessment without promoting a candidate to a verified identity", () => {
    harness.useApi.mockReturnValue(apiResult(response({
      assessment: { status: "ambiguous", reason: "The leading patterns are similarly close." },
    })));
    render(<OpponentIdentityCandidates pulseId="target" enabled />);

    expect(screen.getByText("Several players remain plausible")).toBeTruthy();
    expect(screen.getByText("The leading patterns are similarly close.")).toBeTruthy();
    expect(screen.getByText("Unverified")).toBeTruthy();
  });

  it("keeps the card stable while candidates load", () => {
    harness.useApi.mockReturnValue(
      apiResult(null, { isLoading: true, isValidating: true }),
    );
    render(
      <OpponentIdentityCandidates pulseId="target" enabled race="Zerg" />,
    );

    expect(screen.getByText("Possible identity matches")).toBeTruthy();
    expect(
      screen.getByLabelText("Loading possible identity matches"),
    ).toBeTruthy();
  });

  it("shows a retryable error without inventing an empty result", () => {
    const mutate = vi.fn();
    harness.useApi.mockReturnValue(
      apiResult(null, {
        error: { status: 503, message: "Matcher temporarily unavailable." },
        mutate,
      }),
    );
    render(<OpponentIdentityCandidates pulseId="target" enabled />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Matcher temporarily unavailable.");
    expect(
      screen.queryByText("No credible same-race candidates yet"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      status: "insufficient_data" as const,
      heading: "More replay evidence is needed",
      code: "target_signature_missing",
      message: "Re-sync this replay to extract build and control-group evidence.",
    },
    {
      status: "no_candidates" as const,
      heading: "No credible same-race candidates yet",
      code: "comparable_evidence_missing",
      message:
        "Known same-race opponents exist, but none has enough comparable replay evidence yet.",
    },
  ])("renders the $status state distinctly", ({ status, heading, code, message }) => {
    harness.useApi.mockReturnValue(
      apiResult(
        response({
          status,
          candidates: [],
          insufficiency: { code, message },
        }),
      ),
    );
    render(<OpponentIdentityCandidates pulseId="target" enabled />);

    expect(screen.getByText(heading)).toBeTruthy();
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByTestId("identity-candidate-row")).toBeNull();
  });

  it("retains ready candidates and announces background refreshes", () => {
    harness.useApi.mockReturnValue(apiResult(response(), { isValidating: true }));
    render(<OpponentIdentityCandidates pulseId="target" enabled />);

    expect(screen.getByText("Clem")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Refreshing evidence",
    );
  });

  it("renders nothing when the backend rejects a readable profile", () => {
    harness.useApi.mockReturnValue(
      apiResult(
        response({
          status: "not_eligible",
          eligibility: {
            eligible: false,
            isBarcode: false,
            pulseResolved: true,
            mmrPresent: true,
            reasons: [],
          },
          candidates: [],
        }),
      ),
    );
    const { container } = render(
      <OpponentIdentityCandidates pulseId="target" enabled />,
    );

    expect(container.firstChild).toBeNull();
  });
});
