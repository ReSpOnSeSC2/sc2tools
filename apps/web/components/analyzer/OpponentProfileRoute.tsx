"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ProfileView } from "./ProfileView";
import { storedOpponentListUrl } from "./useOpponentListNavigation";

/**
 * Route wrapper: one opponent's dossier. Back always lands on the
 * opponent list, so a dossier opened from a shared link (with no
 * browser history behind it) never dead-ends.
 */
export function OpponentProfileRoute({ pulseId }: { pulseId: string }) {
  const router = useRouter();
  const [backHref, setBackHref] = useState("/app/opponents");
  const fromList = useRef(false);
  useEffect(() => {
    setBackHref(storedOpponentListUrl());
    try { fromList.current = sessionStorage.getItem("opponents:from-list") === "1"; } catch { /* Use the explicit link. */ }
  }, []);
  return (
    <ProfileView
      pulseId={pulseId}
      backHref={backHref}
      onBack={() => { if (fromList.current && window.history.length > 1) router.back(); else router.push(backHref); }}
    />
  );
}
