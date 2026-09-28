"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { OnboardingWelcome } from "@/components/onboarding/OnboardingWelcome";
import { OnboardingDownload } from "@/components/onboarding/OnboardingDownload";
import {
  OnboardingImport,
  type OnboardingImportMode,
} from "@/components/onboarding/OnboardingImport";
import { OnboardingPair } from "@/components/onboarding/OnboardingPair";
import { useInstantImport } from "@/lib/instant/useInstantImport";

/**
 * /welcome — 4-step onboarding wizard. Step 1 orients, Step 2 surfaces
 * the agent installer with real release metadata, Step 3 mints a real
 * pairing code and waits for the agent to claim it, Step 4 offers a
 * one-click import of the user's existing replay history so the
 * dashboard opens populated.
 *
 * Browser import (Instant Analysis flag on): Step 2 also offers "Skip the
 * download — import in your browser", which jumps straight to Step 4 in
 * browser mode (replays analysed in this tab, no agent or pairing).
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
  const { enabled: browserImportEnabled } = useInstantImport();
  const [importMode, setImportMode] = useState<OnboardingImportMode>("agent");

  return (
    <OnboardingShell
      onClose={close}
      renderStep={(helpers) => {
        switch (helpers.step) {
          case "welcome":
            return <OnboardingWelcome helpers={helpers} />;
          case "download":
            return (
              <OnboardingDownload
                helpers={helpers}
                onBrowserImport={
                  browserImportEnabled
                    ? () => {
                        setImportMode("browser");
                        helpers.goTo("import");
                      }
                    : undefined
                }
              />
            );
          case "pair":
            // Reaching Import through Pair (including Back from a browser
            // import) is the agent path again.
            return (
              <OnboardingPair
                onContinue={() => {
                  setImportMode("agent");
                  helpers.next();
                }}
              />
            );
          case "import":
            return <OnboardingImport mode={importMode} />;
          default:
            return null;
        }
      }}
    />
  );
}
