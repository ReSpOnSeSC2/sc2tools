"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useSWRConfig } from "swr";
import { ChevronDown, Crosshair } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signInHref } from "@/lib/authLinks";
import { safeReturnPath } from "@/lib/safeReturnPath";
import { queuePendingIntent } from "@/lib/pendingIntent";
import type { GhostMatchupKey } from "@/lib/ghostBuild";
import type { PracticeInput } from "@/lib/practiceAssignment";

import { PracticeDialog } from "./PracticeDialog";
import { usePracticeAuthReturn } from "./PracticeAuthReturn";
const RACES: Record<string, string> = { p: "P", protoss: "P", t: "T", terran: "T", z: "Z", zerg: "Z" };
const race = (value?: string) => RACES[value?.trim().toLowerCase() ?? ""];

/** Lightweight split trigger: target resolution, codec and API code load on
 * action. Rendering a build library does not start per-card preference reads. */
export function PracticeController({ build, target, guideHref, privateBuild, matchup: initialMatchup, startOpen = false, onClose, onPractice, initialAction }: PracticeInput & {
  matchup?: GhostMatchupKey; startOpen?: boolean; onClose?: () => void; onPractice?: () => void; initialAction?: "quick" | "options" | "resume";
}) {
  const auth = useAuth();
  const router = useRouter();
  const input = { build, target, guideHref, privateBuild };
  const path = safeReturnPath(typeof window === "undefined" ? null : window.location.pathname + window.location.search)
    ?? safeReturnPath(guideHref) ?? (build.slug && !privateBuild ? safeReturnPath(`/community/builds/${encodeURIComponent(build.slug)}`) : null);
  const owner = auth.isLoaded && auth.isSignedIn && auth.userId ? auth.userId : null;
  const scope = `${owner ?? ""}:${privateBuild ? "private" : "public"}:${build.slug ?? build.name}:${build.sourceGameId ?? ""}:${guideHref ?? ""}`;
  const current = useRef(scope); current.current = scope;
  const active = useRef<AbortController | null>(null);
  const { mutate } = useSWRConfig();
  const [open, setOpen] = useState(startOpen);
  const [state, setState] = useState<{ scope: string; busy: boolean; message: string; error: boolean }>({ scope, busy: false, message: "", error: false });
  const resumed = usePracticeAuthReturn({ input, path: path ?? "", enabled: initialAction === "resume" && !!path });
  const myRace = race(build.race), theirs = race(build.vsRace);
  const matchup = initialMatchup ?? (myRace && theirs ? `${myRace}v${theirs}` as GhostMatchupKey : undefined);
  useEffect(() => { current.current = scope; active.current?.abort(); active.current = null; setState({ scope, busy: false, message: "", error: false }); return () => { current.current = ""; const pending = active.current; active.current = null; pending?.abort(); }; }, [scope]);
  const close = () => { setOpen(false); onClose?.(); };
  const assign = async (slot: GhostMatchupKey) => {
    if (resumed.running) return;
    resumed.clearError();
    if (auth.isLoaded && !owner && !privateBuild && path) {
      if (queuePendingIntent("arm-ghost", { matchup: slot, input }, path)) router.push(signInHref(path));
      else setState({ scope, busy: false, message: "Couldn't keep this practice choice. Sign in, then choose Practice again.", error: true });
      return;
    }
    if (!owner || current.current !== scope || active.current) return;
    const controller = new AbortController(); active.current = controller;
    const valid = () => current.current === scope && active.current === controller && !controller.signal.aborted;
    const getToken = async () => {
      const token = await auth.getToken();
      if (!valid() || !token) throw new DOMException("Sign-in changed", "AbortError");
      return token;
    };
    setState({ scope, busy: true, message: "", error: false }); onPractice?.();
    // Includes a stalled lazy chunk as well as authentication/network work.
    const deadline = setTimeout(() => {
      if (!valid()) return;
      setState({ scope, busy: false, message: "Practice took too long to confirm. Check your assignment before trying again.", error: true });
      controller.abort(); active.current = null;
    }, 25_000);
    try {
      const { assignPractice } = await import("@/lib/practiceAssignment");
      if (!valid()) return;
      const result = await assignPractice({ build, target, guideHref, privateBuild }, slot, getToken, controller.signal);
      if (!valid()) return;
      await mutate(["authenticated-api", owner, "/v1/me/preferences/ghost"], (current: import("@/lib/ghostBuild").GhostBuildConfig | undefined) => (current?.revision ?? 0) > (result.config.revision ?? 0) ? current : result.config, { revalidate: false });
      if (!valid()) return;
      const { writeGhostPracticeCache, GHOST_SYNC_EVENT } = await import("@/lib/ghostSyncModel");
      if (!valid()) return;
      writeGhostPracticeCache(owner, result.config); window.dispatchEvent(new Event(GHOST_SYNC_EVENT));
      setState({ scope, busy: false, message: `Practicing “${result.target.name}” in ${slot}. ${result.source}. Your Ghost URL updates automatically.`, error: false });
      void mutate(["authenticated-api", owner, "/v1/me/preferences/ghost"]).catch(() => {});
    } catch (error) {
      if (valid()) setState({ scope, busy: false, error: true, message: error && typeof error === "object" && "message" in error ? String(error.message) : "Couldn't confirm practice. Try again." });
    } finally { clearTimeout(deadline); if (active.current === controller) active.current = null; }
  };
  const assignRef = useRef(assign); assignRef.current = assign;
  const launched = useRef(false);
  useEffect(() => {
    if (launched.current || !initialAction || !auth.isLoaded) return;
    const timer = setTimeout(() => {
      launched.current = true;
      if (initialAction === "quick" && matchup && (owner || !privateBuild && path)) void assignRef.current(matchup);
      else if (initialAction !== "resume") setOpen(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [initialAction, auth.isLoaded, owner, matchup, scope, privateBuild, path]);
  const busy = state.scope === scope && state.busy || resumed.running;
  return <span className="inline-flex min-w-0 max-w-full flex-col gap-1" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    {resumed.error ? <span role="alert" className="text-caption text-danger">{resumed.error}</span> : resumed.running ? <span role="status" className="text-caption text-text-muted">Finishing your practice assignment…</span> : null}
    {!startOpen ? <span className="inline-flex max-w-full rounded-md border border-border bg-bg-surface">
      <button type="button" disabled={!auth.isLoaded || busy} className="inline-flex min-h-11 min-w-0 items-center gap-2 rounded-l-md px-3 text-caption font-semibold text-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => matchup ? void assign(matchup) : setOpen(true)}><Crosshair className="h-4 w-4 shrink-0" aria-hidden />{busy ? "Saving practice…" : matchup ? `Practice in ${matchup}` : "Practice this"}</button>
      <button type="button" disabled={busy || !auth.isLoaded} aria-label={`Practice options for ${build.name}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className="min-h-11 min-w-11 rounded-r-md border-l border-border px-3 text-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><ChevronDown className="h-4 w-4" aria-hidden /></button>
    </span> : null}
    {state.scope === scope && state.message ? <span role={state.error ? "alert" : "status"} className={`max-w-sm break-words text-caption ${state.error ? "text-danger" : "text-text-muted"}`}>{state.message}</span> : null}
    {open ? owner || !privateBuild && path ? <PracticeDialog key={scope} name={build.name} race={myRace ?? (matchup ? matchup[0] : undefined)} matchup={matchup} busy={busy} message={state.scope === scope ? state.message : ""} onAssign={assign} onClose={close} /> : <span className="text-caption"><Link className="inline-flex min-h-11 items-center text-accent underline" href={signInHref(path)}>Sign in to save practice assignments</Link><button className="min-h-11 px-3" onClick={close}>Close</button></span> : null}
  </span>;
}
