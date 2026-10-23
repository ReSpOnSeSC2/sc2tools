"use client";

import { useRouter } from "next/navigation";
import { OpponentsTab } from "./OpponentsTab";
import { SectionHeader } from "./SectionHeader";
import { opponentDossierHref } from "./tabs";

/**
 * Route wrapper: the section header, then the opponent list, with rows
 * navigating to real dossier URLs.
 */
export function OpponentsRoute() {
  const router = useRouter();
  return (
    <div className="space-y-5">
      <SectionHeader tab="opponents" />
      <OpponentsTab
        onOpen={(pulseId) => router.push(opponentDossierHref(pulseId))}
      />
    </div>
  );
}
