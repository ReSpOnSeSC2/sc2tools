export type IdentityMatchStatus =
  | "ready"
  | "not_eligible"
  | "insufficient_data"
  | "no_candidates";

export type EvidenceMode =
  | "build_and_control_groups"
  | "control_groups_only"
  | "build_only"
  | "actions_only"
  | "behavioral"
  | "none";

export type EvidenceConfidence = "high" | "medium" | "low";

export type IdentityMatchEligibility = {
  eligible: boolean;
  isBarcode: boolean;
  pulseResolved: boolean;
  mmrPresent: boolean;
  reasons: string[];
};

export type IdentityMatchTarget = {
  pulseId?: string | null;
  name?: string | null;
  race: string | null;
  raceCode: string | null;
  games: number;
  buildGames?: number;
  controlGroupGames?: number;
  advancedControlGroupGames?: number;
  membershipGames?: number;
  cameraGames?: number;
  actionGames?: number;
  signatureVersion?: number;
  evidenceMode?: EvidenceMode;
  matchup?: string | null;
};

export type BuildOrderMatchEvidence = {
  score: number;
  targetSamples: number;
  candidateSamples: number;
  sharedBuilds: string[];
  sharedMilestones: Array<{ name: string; deltaSec: number }>;
  highlights: string[];
  milestoneSamples?: { target: number; candidate: number };
  detailLevel?: "labels_only" | "timed_milestones";
  reliability?: number;
};

export type BehaviorMatchDimension = {
  key: string;
  label: string;
  score: number | null;
  targetSamples: number;
  candidateSamples: number;
  targetValue?: number;
  candidateValue?: number;
  unit?: string;
};

export type BehavioralEvidence = {
  score: number;
  targetSamples: number;
  candidateSamples: number;
  highlights: string[];
  dimensions?: BehaviorMatchDimension[];
  targetEvents?: number;
  candidateEvents?: number;
  reliability?: number;
  consistency?: { target: number | null; candidate: number | null };
};

export type ControlGroupMatchEvidence = BehavioralEvidence & {
  matchedSlots: number[];
  advancedSamples?: { target: number; candidate: number };
  membershipSamples?: { target: number; candidate: number };
  membershipHabits?: Array<{
    unitType: string;
    /** Two slots mean that the same decoded unit was present in both groups. */
    slots: number[];
    targetGames: number;
    candidateGames: number;
    targetFirstSec?: number;
    candidateFirstSec?: number;
  }>;
  openingExamples?: {
    target: ControlGroupOpeningStep[];
    candidate: ControlGroupOpeningStep[];
  };
};

export type ControlGroupOpeningStep = {
  slot: number;
  action: string;
  atSec: number;
  units: Array<{ name: string; count: number }>;
};

export type ActionMatchEvidence = BehavioralEvidence & {
  cameraHabits?: {
    targetSamples: number;
    candidateSamples: number;
    returnAttribution: "position_only";
    slots: Array<{
      slot: number;
      targetGames: number;
      candidateGames: number;
      targetFirstSaveSec?: number;
      candidateFirstSaveSec?: number;
      targetSavesPerGame?: number;
      candidateSavesPerGame?: number;
      targetReturnsPerGame?: number;
      candidateReturnsPerGame?: number;
    }>;
  };
};

export type IdentityCandidate = {
  rank: number;
  pulseId: string;
  pulseCharacterId: string | null;
  name: string;
  race: string | null;
  region: string | null;
  mmr: number | null;
  gamesInProfile: number;
  /** Open-set, uncalibrated estimate. It is not the raw match score. */
  likelihood: number;
  /** Raw behavioral closeness across the evidence components available. */
  patternMatch: number;
  confidence: EvidenceConfidence;
  evidenceQuality: number;
  sample: {
    targetGames: number;
    candidateGames: number;
    targetEvidenceGames: number;
    candidateEvidenceGames: number;
  };
  evidence: {
    coverage: number;
    buildOrders?: BuildOrderMatchEvidence | null;
    controlGroups?: ControlGroupMatchEvidence | null;
    actions?: ActionMatchEvidence | null;
  };
  caveats: string[];
};

export type OpponentIdentityCandidatesResponse = {
  status: IdentityMatchStatus;
  calibrated: false;
  methodologyVersion: string;
  generatedAt?: string;
  eligibility: IdentityMatchEligibility;
  target: IdentityMatchTarget;
  candidates: IdentityCandidate[];
  /** Probability mass reserved for a player absent from the known candidate set. */
  unknownLikelihood: number;
  /** Probability mass for known candidates ranked below the five returned rows. */
  otherLikelihood: number;
  scope: {
    source: string;
    searchedOpponents: number;
    searchedGames: number;
    truncated: boolean;
  };
  insufficiency?: { code: string; message: string };
  assessment?: {
    status: "insufficient" | "ambiguous" | "lead";
    reason: string;
  };
};

export interface OpponentIdentityCandidatesProps {
  pulseId: string;
  enabled: boolean;
  race?: string | null;
}

