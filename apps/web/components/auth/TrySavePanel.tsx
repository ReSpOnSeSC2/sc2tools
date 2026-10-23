"use client";

import { useEffect, useState } from "react";
import { countTryGames } from "@/lib/instant/localStore";

/** The count is local to this browser; replay files are never uploaded here. */
export function TrySavePanel() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    countTryGames(Date.now()).then(
      (value) => { if (active) setCount(value); },
      () => { if (active) setCount(null); },
    );
    return () => { active = false; };
  }, []);
  const message = count === 0
    ? "Sign in to keep analyzing."
    : count === null
      ? "Your analyzed games will be saved to your account."
      : `Your ${count} analyzed ${count === 1 ? "game" : "games"} will be saved to your account.`;
  return <div className="space-y-3"><h1 className="text-h2 font-semibold text-text">Save your /try report</h1><p className="text-body-lg text-text-muted">{message} Replay files stay on your device.</p></div>;
}
