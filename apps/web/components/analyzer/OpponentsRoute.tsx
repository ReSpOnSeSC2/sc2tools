"use client";

import { useRouter } from "next/navigation";
import { OpponentsTab } from "./OpponentsTab";
import { opponentDossierHref } from "./tabs";

/** Route wrapper: the opponent list, with rows navigating to real dossier URLs. */
export function OpponentsRoute() {
  const router = useRouter();
  return (
    <OpponentsTab
      onOpen={(pulseId) => router.push(opponentDossierHref(pulseId))}
    />
  );
}
