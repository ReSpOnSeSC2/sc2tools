import type { OnboardingStepId } from "./types";

export const WELCOME_STEPS: ReadonlyArray<{ id: OnboardingStepId; label: string }> = [
  { id: "welcome", label: "Welcome" },
  { id: "download", label: "Download" },
  { id: "pair", label: "Pair" },
  { id: "import", label: "Import" },
  { id: "done", label: "Done" },
];

export type OnboardingGoal = "improve" | "stream";
export type WelcomeMe = {
  agentPaired: boolean;
  agentVersion?: string | null;
  games: { total: number };
  onboarding?: { goals?: OnboardingGoal[]; [field: string]: unknown } | null;
};

export function isWelcomeStep(value: string | null): value is OnboardingStepId {
  return WELCOME_STEPS.some((item) => item.id === value);
}

export function resumeWelcomeStep(me?: WelcomeMe): OnboardingStepId {
  return me?.games.total ? "done" : me?.agentPaired ? "import" : "welcome";
}

export function previousWelcomeStep(step: OnboardingStepId, browser: boolean): OnboardingStepId {
  if (step === "import" && browser) return "download";
  return WELCOME_STEPS[Math.max(0, WELCOME_STEPS.findIndex((item) => item.id === step) - 1)].id;
}

export function nextWelcomeStep(step: OnboardingStepId, paired: boolean): OnboardingStepId {
  if (step === "download" && paired) return "import";
  return WELCOME_STEPS[Math.min(WELCOME_STEPS.length - 1, WELCOME_STEPS.findIndex((item) => item.id === step) + 1)].id;
}

export function completedWelcomeSteps(step: OnboardingStepId, paired: boolean) {
  const index = WELCOME_STEPS.findIndex((item) => item.id === step);
  return WELCOME_STEPS.filter((item, i) => item.id === "pair" ? paired : i < index).map((item) => item.id);
}
