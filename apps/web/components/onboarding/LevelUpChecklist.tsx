"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { ACTIVATION_PATH, activationProgress, validActivation, type ActivationResponse, type ActivationRow } from "@/lib/activation";
import { apiCall, useApi, useOwnerRequestScope } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { Button, LinkButton } from "@/components/ui/Button";
import { RequestError } from "@/components/ui/RequestError";
import { useToastOptional } from "@/components/ui/Toast";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { tourReplayHref } from "@/lib/tours";

/** A fresh mounted lifetime for every account transition, including A→B→A. */
export function LevelUpChecklist() {
  const auth = useAuth();
  const owner = auth.isLoaded && auth.isSignedIn ? auth.userId : null;
  return owner ? <OwnerChecklist key={owner} owner={owner} /> : null;
}

function OwnerChecklist({ owner }: { owner: string }) {
  const { getToken } = useAuth();
  const runOwned = useOwnerRequestScope(owner, getToken);
  const query = useApi<ActivationResponse>(ACTIVATION_PATH, {
    keepPreviousData: false, dedupingInterval: 60_000, refreshInterval: 60_000,
    refreshWhenHidden: false, revalidateOnFocus: false, shouldRetryOnError: false,
  }, { timeoutMs: 15_000 });
  const lifetime = useRef({ active: true, pending: null as AbortController | null });
  const previousComplete = useRef<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [pending, setPending] = useState(false);
  const [dismissError, setDismissError] = useState<unknown>(null);
  const notifications = useToastOptional();
  const data = !query.error && !query.isPreviousData && validActivation(query.data) ? query.data : null;
  const progress = data ? activationProgress(data) : null;
  const hidden = dismissed || !!data?.levelUpDismissedAt;

  useLayoutEffect(() => {
    const current = lifetime.current; current.active = true;
    return () => { current.active = false; current.pending?.abort(); };
  }, []);
  useEffect(() => {
    if (!progress || hidden || !lifetime.current.active) return;
    if (previousComplete.current === false && progress.complete) notifications?.toast.success("You're all set", { description: "Your suggested SC2 Tools features are ready to use." });
    previousComplete.current = progress.complete;
  }, [progress, hidden, notifications]);

  async function dismiss() {
    const current = lifetime.current;
    if (!current.active || current.pending) return;
    const controller = new AbortController(); current.pending = controller;
    setPending(true);
    const assert = () => { if (!current.active || controller.signal.aborted) throw new DOMException("Checklist closed", "AbortError"); };
    try {
      const stamp = new Date().toISOString();
      await runOwned(owner, async (token, signal, assertOwner) => {
        assert();
        const saved = await apiCall<{ levelUpDismissedAt?: unknown } | null>(token, "/v1/me/preferences/onboarding", { method: "PUT", body: JSON.stringify({ levelUpDismissedAt: stamp }), signal });
        assertOwner(); assert();
        if (saved?.levelUpDismissedAt !== stamp) throw new Error("Your dismissal was not confirmed. Try again.");
        await query.mutate(value => { assertOwner(); assert(); return value ? { ...value, levelUpDismissedAt: stamp } : value; }, { revalidate: false });
        assertOwner(); assert(); setDismissed(true);
      }, 15_000, controller.signal);
    } catch (error) { if (current.active && !controller.signal.aborted) setDismissError(error); }
    finally { if (current.pending === controller) current.pending = null; if (current.active) setPending(false); }
  }

  if (hidden) return null;
  if (query.error) return <RequestError title="Get more out of SC2 Tools" error={query.error} onRetry={() => query.mutate()} />;
  if (query.data !== undefined && !validActivation(query.data)) return <RequestError title="Get more out of SC2 Tools" error={new Error("Your suggested steps could not be read. Please try again.")} onRetry={() => query.mutate()} />;
  if (!data || !progress) return <Card data-testid="level-up-checklist"><p role="status">Loading your suggested next steps…</p></Card>;
  if (progress.complete) return <Card data-tour="today-next-steps" data-testid="level-up-checklist"><div className="flex flex-wrap items-center justify-between gap-3"><p className="font-semibold">You&apos;re all set — <LinkButton href="/changelog" variant="ghost" size="sm">see What&apos;s new</LinkButton></p><LinkButton href={tourReplayHref("today")} variant="ghost" size="sm">Take the Today tour</LinkButton><Button variant="ghost" size="sm" aria-busy={pending || undefined} aria-disabled={pending || undefined} onClick={() => void dismiss()}>{pending ? "Dismissing…" : "Dismiss suggestions"}</Button></div>{dismissError ? <div className="mt-3"><RequestError error={dismissError} onRetry={dismiss} /></div> : null}</Card>;
  return <Card data-tour="today-next-steps" data-testid="level-up-checklist">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 basis-48 flex-1"><h2 className="text-h3 font-bold">Get more out of SC2 Tools</h2><p className="mt-1 text-caption text-text-muted">{progress.done} of {progress.total} done · Try the features that fit your goals.</p><LazyHelpLink slug="your-first-week" className="mt-1 text-caption">Your first week</LazyHelpLink></div>
      <LinkButton href={tourReplayHref("today")} variant="ghost" size="sm">Take the Today tour</LinkButton>
      <ProgressRing done={progress.done} total={progress.total} />
      <Button variant="ghost" size="sm" aria-busy={pending || undefined} aria-disabled={pending || undefined} onClick={() => void dismiss()}>{pending ? "Dismissing…" : "Dismiss suggestions"}</Button>
    </div>
    <ol className="mt-4 space-y-3">{progress.rows.map(row => <FeatureRow key={row.id} row={row} done={data[row.id]} />)}</ol>
    {dismissError ? <div className="mt-3"><RequestError error={dismissError} onRetry={dismiss} /></div> : null}
  </Card>;
}

function ProgressRing({ done, total }: { done: number; total: number }) {
  return <div role="progressbar" aria-label="Suggested features tried" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="h-12 w-12 shrink-0 text-accent">
    <svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="4" className="opacity-20" /><circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="4" pathLength="100" strokeDasharray={`${100 * done / total} 100`} transform="rotate(-90 20 20)" /></svg>
  </div>;
}

function FeatureRow({ row, done }: { row: ActivationRow; done: boolean }) {
  return <li className="rounded-xl border border-border bg-bg-elevated/40 p-3">
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${done ? "border-success text-success" : "border-border text-text-muted"}`}>{done ? "✓" : "○"}</span>
      <div className="grid min-w-0 flex-1 gap-2 sm:flex sm:items-start sm:gap-3">
        <div className="min-w-0 flex-1"><h3 className="text-body font-semibold">{row.title}<span className="sr-only">{done ? ", done" : ", not yet tried"}</span></h3><p className="mt-0.5 text-caption text-text-muted">{row.why}</p><LazyHelpLink slug={row.help} className="text-caption">How it works</LazyHelpLink></div>
        {done ? null : <div className="shrink-0"><LinkButton href={row.href} variant="secondary" size="sm">{row.action}</LinkButton></div>}
      </div>
    </div>
  </li>;
}
