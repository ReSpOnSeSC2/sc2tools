"use client";

import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { OnboardingWelcome } from "@/components/onboarding/OnboardingWelcome";
import { OnboardingDownload } from "@/components/onboarding/OnboardingDownload";
import { OnboardingPair } from "@/components/onboarding/OnboardingPair";

/**
 * /welcome — 3-step onboarding wizard. Step 1 orients, Step 2 surfaces
 * the agent installer with real release metadata, Step 3 mints a real
 * pairing code and waits for the agent to claim it.
 *
 * Skip behaviour: every step has a "Skip for now" affordance in the
 * shell's bottom action bar. We send the user to /app — the same
 * destination the final CTA uses on success — so the dashboard's own
 * empty states guide them back to /settings or /devices when they
 * choose to finish onboarding later.
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
            return <OnboardingPair />;
          default:
            return null;
        }
      }}
    />
  );
}
