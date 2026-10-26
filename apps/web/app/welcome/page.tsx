"use client";

import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
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
import { apiCall, boundedApiRequest, useApi } from "@/lib/clientApi";
import { completedWelcomeSteps, isWelcomeStep, nextWelcomeStep, previousWelcomeStep, resumeWelcomeStep, type OnboardingGoal, type WelcomeMe } from "@/components/onboarding/welcomeState";
import type { OnboardingStepId } from "@/components/onboarding/types";
import { safeReturnPath } from "@/lib/safeReturnPath";
import { signInHref } from "@/lib/authLinks";

const OnboardingImport = dynamic(() => import("@/components/onboarding/OnboardingImport").then((module) => module.OnboardingImport), { loading: () => <p role="status">Loading import…</p> });
const OnboardingDone = dynamic(() => import("@/components/onboarding/OnboardingDone").then((module) => module.OnboardingDone), { loading: () => <p role="status">Loading next steps…</p> });

/** Five-minute setup: URL progress and server completion survive a refresh. */
export default function WelcomePage() {
  const { userId, isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <p role="status">Loading setup…</p>;
  if (!isSignedIn || !userId) return <Suspense fallback={<p role="status">Loading setup…</p>}><WelcomeSignIn /></Suspense>;
  return <Suspense fallback={<p role="status">Loading setup…</p>}><WelcomeWizard key={userId} owner={userId} /></Suspense>;
}

function WelcomeSignIn() {
  const params = useSearchParams();
  return <p role="status"><Link href={signInHref(safeReturnPath(params.get("next")))} className="inline-flex min-h-11 items-center font-semibold text-accent underline">Sign in to continue setup.</Link></p>;
}

function WelcomeWizard({ owner }: { owner: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const query = params.toString();
  const destination = safeReturnPath(params.get("next"));
  const { getToken } = useAuth();
  const { enabled: browserImportEnabled } = useInstantImport();
  const me = useApi<WelcomeMe>("/v1/me", { refreshInterval: 5000 }, { timeoutMs: 20_000 });
  const requested = params.get("step");
  const resolved = useRef(isWelcomeStep(requested));
  const [step, setStep] = useState<OnboardingStepId>(isWelcomeStep(requested) ? requested : "welcome");
  const [browser, setBrowser] = useState(browserImportEnabled && params.get("mode") === "browser");
  const [goals, setGoals] = useState<OnboardingGoal[]>(["improve"]);
  const goalsEdited = useRef(false);
  const key = JSON.stringify([owner, destination]);
  const scope = useRef({ key }); if (scope.current.key !== key) scope.current = { key };
  const identity = scope.current;
  const [saveState, setSaveState] = useState({ identity, saving: false, error: "" });
  const saving = saveState.identity === identity && saveState.saving;
  const error = saveState.identity === identity ? saveState.error : "";
  const active = useRef(false);
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; pending.current?.abort(); pending.current = null; }; }, [identity]);

  function goTo(next: OnboardingStepId, browserMode = browser) {
    resolved.current = true; setStep(next); setBrowser(browserMode);
    const nextQuery = new URLSearchParams(query); nextQuery.set("step", next);
    if (browserMode) nextQuery.set("mode", "browser"); else nextQuery.delete("mode");
    router.replace("/welcome?" + nextQuery, { scroll: false });
  }

  useEffect(() => {
    const next = new URLSearchParams(query);
    const value = next.get("step");
    if (isWelcomeStep(value)) { resolved.current = true; setStep(value); setBrowser(browserImportEnabled && next.get("mode") === "browser"); }
  }, [query, browserImportEnabled]);
  useEffect(() => {
    if (!me.data) return;
    if (!goalsEdited.current && me.data.onboarding?.goals) setGoals(me.data.onboarding.goals);
    if (!resolved.current) goTo(resumeWelcomeStep(me.data));
    // Resume once; a background refresh must never pull someone out of a step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data]);

  async function saveGoals() {
    if (!active.current || scope.current !== identity || pending.current) return;
    setSaveState({ identity, saving: true, error: "" });
    const controller = new AbortController(); pending.current = controller;
    const valid = () => active.current && scope.current === identity && pending.current === controller && !controller.signal.aborted;
    try {
      await boundedApiRequest(async signal => {
        const current = () => valid() && !signal.aborted;
        const safeToken = async () => {
          if (!current()) throw new DOMException("Sign-in changed", "AbortError");
          const jwt = await getToken();
          if (!current()) throw new DOMException("Sign-in changed", "AbortError");
          return jwt;
        };
        await apiCall(safeToken, "/v1/me/preferences/onboarding", { method: "PUT", body: JSON.stringify({ goals }), signal });
        if (!current()) return;
        await me.mutate();
        if (!current()) return;
        goTo(nextWelcomeStep("welcome", Boolean(me.data?.agentPaired)));
      }, 20_000, controller.signal);
    } catch (failure) { if (valid()) setSaveState({ identity, saving: false, error: failure && typeof failure === "object" && "message" in failure ? String(failure.message) : "Couldn't save your choices. Please try again." }); }
    finally { if (pending.current === controller) { pending.current = null; if (active.current && scope.current === identity) setSaveState(previous => ({ ...previous, saving: false })); } }
  }

  const paired = Boolean(me.data?.agentPaired);
  const help = step === "download" ? "install-and-pair" : step === "pair" ? "pairing-troubleshooting" : step === "done" ? "dashboard-and-analyzer" : "getting-started";
  return <>
    {me.error ? <div role="alert" className="mx-auto max-w-2xl p-4 text-caption">Couldn't check your saved setup. You can keep going or <Button size="sm" variant="ghost" onClick={() => { void me.mutate(); }}>Retry</Button>.</div> : null}
    <OnboardingShell returnTo={destination} activeStep={step} onStepChange={goTo} onNext={() => goTo(nextWelcomeStep(step, paired))} onPrevious={() => goTo(previousWelcomeStep(step, browser))} completedSteps={completedWelcomeSteps(step, paired)} onClose={() => router.push(destination ?? "/app")} renderStep={(helpers) => <div className="space-y-6">
      {step === "welcome" ? <OnboardingWelcome helpers={helpers} goals={goals} onGoalsChange={(value) => { goalsEdited.current = true; setGoals(value); }} onContinue={() => { void saveGoals(); }} saving={saving} error={error} /> : null}
      {step === "download" ? <OnboardingDownload helpers={helpers} alreadyPaired={paired} onBrowserImport={browserImportEnabled ? () => goTo("import", true) : undefined} /> : null}
      {step === "pair" ? <OnboardingPair alreadyPaired={paired} onContinue={() => { goTo("import", false); void me.mutate(); }} /> : null}
      {step === "import" ? <OnboardingImport mode={browser ? "browser" : "agent"} onContinue={() => goTo("done")} /> : null}
      {step === "done" ? <OnboardingDone me={me.data} goals={goals} returnTo={destination} /> : null}
      <LazyHelpLink slug={help}>Need help with this step?</LazyHelpLink>
    </div>} />
  </>;
}
