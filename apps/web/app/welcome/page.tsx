"use client";

import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { OnboardingWelcome } from "@/components/onboarding/OnboardingWelcome";
import { OnboardingDownload } from "@/components/onboarding/OnboardingDownload";
import { OnboardingImport } from "@/components/onboarding/OnboardingImport";
import { OnboardingPair } from "@/components/onboarding/OnboardingPair";

/**
 * /welcome — 4-step onboarding wizard. Step 1 orients, Step 2 surfaces
 * the agent installer with real release metadata, Step 3 mints a real
 * pairing code and waits for the agent to claim it, Step 4 offers a
 * one-click import of the user's existing replay history so the
 * dashboard opens populated.
 *
 * Skip behaviour: every step has a "Skip for now" affordance in the
 * shell's bottom action bar. We send the user to /app — the same
 * destination the final CTA uses on success — so the dashboard's own
 * onboarding checklist guides them back when they choose to finish
 * later.
 */
export default function WelcomePage() {
  const router = useRouter();
  const close = () => router.push("/app");

  return (
    <OnboardingShell
      onClose={close}
      renderStep={(helpers) => {
        switch (helpers.step) {
          case "welcome":
            return <OnboardingWelcome helpers={helpers} />;
          case "download":
            return <OnboardingDownload helpers={helpers} />;
          case "pair":
            return <OnboardingPair onContinue={() => helpers.next()} />;
          case "import":
            return <OnboardingImport />;
          default:
            return null;
        }
      }}
    />
  );
}
