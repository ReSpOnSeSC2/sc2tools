import type { DossierAnalysis } from "./dossierTypes";

export type PlanLabel = { name: string; count: number; sampleGameIds: string[]; sampleLimit: number; sampleTruncated: boolean };
export type BuildPlan = {
  declared: number; held: number; knockedOff: number; heldRate: number | null;
  heldWR: number | null; knockedOffWR: number | null; heldDecided: number; knockedOffDecided: number;
  knockedInto: PlanLabel[]; knockedBy: PlanLabel[];
  medianKnockedOffDurationSec: number | null; durationSamples: number; durationEstimated: boolean;
};
export type CommunityTiming = { token: string; p25Seconds: number; medianSeconds: number; p75Seconds: number; sampleCount: number; users: number; event: "start" };
export type CommunityTimings = Record<string, { href: string; era: string; computedAt: string | null; rows: CommunityTiming[] }>;
export type BuildDossierInsightsData = DossierAnalysis & {
  timingSampleGames?: number; timingSampleLimit?: number; timingsTruncated?: boolean;
  communityTimings?: CommunityTimings; plan?: BuildPlan | null;
};

export function hasPlanSurvival(plan: BuildPlan | null | undefined): plan is BuildPlan {
  return !!plan && Number.isFinite(plan.declared) && plan.declared >= 5 && plan.held >= 0 && plan.knockedOff >= 0 && plan.held + plan.knockedOff === plan.declared;
}

/** Dynamic axes preserve real seconds; an outlier never gets silently capped. */
export function timingAxis(values: Array<number | null | undefined>): number {
  const max = Math.max(60, ...values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0));
  return Math.ceil(max / 60) * 60;
}
