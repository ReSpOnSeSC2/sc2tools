"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { PairDeviceForm } from "./PairDeviceForm";

export function OnboardingPair({ onContinue, alreadyPaired = false }: { onContinue?: () => void; alreadyPaired?: boolean } = {}) {
  const router = useRouter();
  const [paired, setPaired] = useState(false);
  return <section aria-labelledby="onboarding-step-heading" className="space-y-8">
    <header className="space-y-2">
      <h1 id="onboarding-step-heading" tabIndex={-1} className="text-display-lg font-semibold tracking-tight text-text outline-none">Pair this machine</h1>
      <p className="text-body-lg text-text-muted">Run SC2 Tools on your gaming PC, then link it to your account here.</p>
    </header>
    {alreadyPaired ? <p role="status" className="text-success">A PC is already paired to your account. Continue to import, or link another PC below.</p> : null}
    <PairDeviceForm onPaired={() => setPaired(true)} />
    {paired || alreadyPaired ? <div className="flex justify-end"><Button size="lg" onClick={onContinue || (() => router.push("/app"))} aria-label={onContinue ? "Continue to import" : "Open the dashboard"}>{onContinue ? "Continue →" : "Open your dashboard →"}</Button></div> : null}
  </section>;
}
