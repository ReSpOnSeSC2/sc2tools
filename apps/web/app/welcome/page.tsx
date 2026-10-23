"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { OnboardingWelcome } from "@/components/onboarding/OnboardingWelcome";
import { OnboardingDownload } from "@/components/onboarding/OnboardingDownload";
import { OnboardingPair } from "@/components/onboarding/OnboardingPair";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { Button } from "@/components/ui/Button";
import { useInstantImport } from "@/lib/instant/useInstantImport";
import { apiCall, useApi } from "@/lib/clientApi";
import { completedWelcomeSteps, isWelcomeStep, nextWelcomeStep, previousWelcomeStep, resumeWelcomeStep, type OnboardingGoal, type WelcomeMe } from "@/components/onboarding/welcomeState";
import type { OnboardingStepId } from "@/components/onboarding/types";

const OnboardingImport = dynamic(() => import("@/components/onboarding/OnboardingImport").then((module) => module.OnboardingImport), { loading: () => <p role="status">Loading import…</p> });
const OnboardingDone = dynamic(() => import("@/components/onboarding/OnboardingDone").then((module) => module.OnboardingDone), { loading: () => <p role="status">Loading next steps…</p> });

/** Five-minute setup: URL progress and server completion survive a refresh. */
export default function WelcomePage() {
  const { userId } = useAuth();
  return <Suspense fallback={<p role="status">Loading setup…</p>}><WelcomeWizard key={userId || "signed-out"} /></Suspense>;
}

function WelcomeWizard() {
  const router = useRouter();
  const params = useSearchParams();
  const query = params.toString();
  const { getToken } = useAuth();
  const { enabled: browserImportEnabled } = useInstantImport();
  const me = useApi<WelcomeMe>("/v1/me", { refreshInterval: 5000 });
  const requested = params.get("step");
  const resolved = useRef(isWelcomeStep(requested));
  const [step, setStep] = useState<OnboardingStepId>(isWelcomeStep(requested) ? requested : "welcome");
  const [browser, setBrowser] = useState(browserImportEnabled && params.get("mode") === "browser");
  const [goals, setGoals] = useState<OnboardingGoal[]>(["improve"]);
  const goalsEdited = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; pending.current?.abort(); }; }, []);

  function goTo(next: OnboardingStepId, browserMode = browser) {
    resolved.current = true; setStep(next); setBrowser(browserMode);
    const nextQuery = new URLSearchParams(query); nextQuery.set("step", next);
    if (browserMode) nextQuery.set("mode", "browser"); else nextQuery.delete("mode");
    router.replace("/welcome?" + nextQuery, { scroll: false });
  }

  useEffect(() => {
    const next = new URLSearchParams(query);
    const value = next.get("step");
    if (isWelcomeStep(value)) { setStep(value); setBrowser(browserImportEnabled && next.get("mode") === "browser"); }
  }, [query, browserImportEnabled]);
  useEffect(() => {
    if (!me.data) return;
    if (!goalsEdited.current && me.data.onboarding?.goals) setGoals(me.data.onboarding.goals);
    if (!resolved.current) goTo(resumeWelcomeStep(me.data));
    // Resume once; a background refresh must never pull someone out of a step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data]);

  async function saveGoals() {
    if (saving) return;
    setSaving(true); setError("");
    const controller = new AbortController(); pending.current = controller;
    try {
      await apiCall(getToken, "/v1/me/preferences/onboarding", { method: "PUT", body: JSON.stringify({ goals }), signal: controller.signal });
      if (!active.current) return;
      goTo(nextWelcomeStep("welcome", Boolean(me.data?.agentPaired)));
      void me.mutate();
    } catch (failure) { if (active.current) setError(failure && typeof failure === "object" && "message" in failure ? String(failure.message) : "Couldn't save your choices. Please try again."); }
    finally { pending.current = null; if (active.current) setSaving(false); }
  }

  const paired = Boolean(me.data?.agentPaired);
  const help = step === "download" ? "install-and-pair" : step === "pair" ? "pairing-troubleshooting" : step === "done" ? "dashboard-and-analyzer" : "getting-started";
  return <>
    {me.error ? <div role="alert" className="mx-auto max-w-2xl p-4 text-caption">Couldn't check your saved setup. You can keep going or <Button size="sm" variant="ghost" onClick={() => { void me.mutate(); }}>Retry</Button>.</div> : null}
    <OnboardingShell activeStep={step} onStepChange={goTo} onNext={() => goTo(nextWelcomeStep(step, paired))} onPrevious={() => goTo(previousWelcomeStep(step, browser))} completedSteps={completedWelcomeSteps(step, paired)} onClose={() => router.push("/app")} renderStep={(helpers) => <div className="space-y-6">
      {step === "welcome" ? <OnboardingWelcome helpers={helpers} goals={goals} onGoalsChange={(value) => { goalsEdited.current = true; setGoals(value); }} onContinue={() => { void saveGoals(); }} saving={saving} error={error} /> : null}
      {step === "download" ? <OnboardingDownload helpers={helpers} alreadyPaired={paired} onBrowserImport={browserImportEnabled ? () => goTo("import", true) : undefined} /> : null}
      {step === "pair" ? <OnboardingPair alreadyPaired={paired} onContinue={() => { goTo("import", false); void me.mutate(); }} /> : null}
      {step === "import" ? <OnboardingImport mode={browser ? "browser" : "agent"} onContinue={() => goTo("done")} /> : null}
      {step === "done" ? <OnboardingDone me={me.data} goals={goals} /> : null}
      <LazyHelpLink slug={help}>Need help with this step?</LazyHelpLink>
    </div>} />
  </>;
}
