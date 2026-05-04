"use client";

import { useRouter } from "next/navigation";
import {
  WizardShell,
  type WizardStepId,
} from "@/components/analyzer/wizard/WizardShell";
import { WizardFoundation } from "@/components/analyzer/wizard/WizardFoundation";
import { WizardStepsEarly } from "@/components/analyzer/wizard/WizardStepsEarly";
import { WizardIntegrations } from "@/components/analyzer/wizard/WizardIntegrations";
import { WizardStreamlabs } from "@/components/analyzer/wizard/WizardStreamlabs";
import { WizardApplyImport } from "@/components/analyzer/wizard/WizardApplyImport";

export default function WelcomePage() {
  const router = useRouter();
  return (
    <WizardShell
      onClose={() => router.push("/app")}
      renderStep={(id: WizardStepId) => {
        switch (id) {
          case "foundation":
            return <WizardFoundation />;
          case "early":
            return <WizardStepsEarly />;
          case "integrations":
            return <WizardIntegrations />;
          case "streamlabs":
            return <WizardStreamlabs />;
          case "apply-import":
            return <WizardApplyImport />;
          default:
            return null;
        }
      }}
    />
  );
}
