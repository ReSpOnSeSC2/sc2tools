"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ScoutingBriefCard } from "./ScoutingBriefCard";
import { useLiveScouting } from "./useLiveScouting";
import { Button } from "@/components/ui/Button";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";

export function LiveScoutingScreen() {
  const { live, unavailable, retry, connected } = useLiveScouting();
  const [keepAwake, setKeepAwake] = useState(true), [wake, setWake] = useState("Checking screen wake lock…");
  useEffect(() => {
    let active = true, pending = false, lock: WakeLockSentinel | null = null;
    const request = async () => {
      if (!keepAwake) { setWake("Screen wake lock off"); return; }
      if (!navigator.wakeLock) { setWake("Screen wake lock unavailable in this browser"); return; }
      if (document.visibilityState !== "visible") return;
      if (pending || (lock && !lock.released)) return;
      pending = true;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (!active || document.visibilityState !== "visible") { await next.release(); return; }
        lock = next; setWake("Keeping this screen awake while visible");
        next.addEventListener("release", () => { if (active) setWake("Screen wake lock released"); });
      } catch { if (active) setWake("Screen wake lock unavailable; your browser controls sleep"); }
      finally { pending = false; }
    };
    void request(); document.addEventListener("visibilitychange", request);
    return () => { active = false; document.removeEventListener("visibilitychange", request); void lock?.release().catch(() => {}); };
  }, [keepAwake]);
  return <div className="mx-auto max-w-5xl space-y-5">
    <header className="space-y-3"><Link href="/app" className="inline-flex min-h-11 items-center text-accent underline">Back to Today</Link><h1 className="text-h1 font-semibold">Live scouting</h1><p className="text-body text-text-muted">{connected ? "Connected to your desktop’s live updates" : "Connecting to live updates…"} · Your account’s replay history</p></header>
    <ScoutingBriefCard key={live?.gameKey || live?.opponent?.name || "waiting"} live={live} unavailable={unavailable} large onRetry={retry} />
    <div className="flex flex-wrap items-center gap-3"><Button variant="secondary" size="sm" aria-pressed={keepAwake} onClick={() => setKeepAwake(value => !value)}>Keep screen awake</Button><p role="status" className="text-caption text-text-muted">{wake}</p><LazyHelpLink slug="live-scouting">How live scouting works</LazyHelpLink></div>
  </div>;
}
