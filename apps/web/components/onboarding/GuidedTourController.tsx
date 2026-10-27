"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { useSWRConfig } from "swr";
import { apiCall, useApi, useOwnerRequestScope } from "@/lib/clientApi";
import { ONBOARDING_PREFERENCES_PATH, TOURS, tourAvailabilityKey, tourIsDone, tourStepsPresent, tourVersions, type TourId, type TourStep, type TourAvailability, type TourAvailabilityScope } from "@/lib/tours";
import { Button } from "@/components/ui/Button";
import { Tour } from "@/components/ui/Tour";

type Preferences = Record<string, unknown> & { toursDone?: unknown };
type PresentStep = { step: TourStep; target: HTMLElement };
type Environment = { steps: readonly PresentStep[] | null; blocked: boolean; resolved: boolean };
const plainPreferences = (value: unknown): value is Preferences => !!value && typeof value === "object" && !Array.isArray(value);
function rendered(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest("[hidden],[inert],[aria-hidden='true']")) return false;
  const style = getComputedStyle(element), rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}
function hasBlocker(): boolean {
  if (document.fullscreenElement) return true;
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"],[role="alertdialog"],[data-tour-blocker="check-in"]')).some(element => {
    if (element.closest("[data-tour-overlay]") || !rendered(element)) return false;
    if (!element.hasAttribute("data-tour-blocker")) return true;
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  });
}
function sameEnvironment(previous: Environment, next: Environment): boolean {
  return previous.resolved === next.resolved && previous.blocked === next.blocked && (previous.steps === null ? next.steps === null
    : next.steps !== null && previous.steps.length === next.steps.length && previous.steps.every((item, index) => item.target === next.steps?.[index]?.target));
}
function useTourEnvironment(id: TourId, root: RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [environment, setEnvironment] = useState<Environment>({ steps: null, blocked: true, resolved: false });
  useLayoutEffect(() => {
    if (!enabled) { setEnvironment(previous => previous.resolved ? { steps: null, blocked: true, resolved: false } : previous); return; }
    let active = true, frame: number | null = null;
    const read = () => {
      frame = null; if (!active || !root.current) return;
      const found = new Map<string, HTMLElement>();
      for (const step of TOURS[id].steps) {
        const candidates = root.current.querySelectorAll<HTMLElement>('[data-tour="' + step.target + '"]');
        if (candidates.length === 1 && rendered(candidates[0])) found.set(step.target, candidates[0]);
      }
      const available = tourStepsPresent(id, new Set(found.keys()));
      const next = { steps: available?.map(step => ({ step, target: found.get(step.target)! })) ?? null, blocked: hasBlocker(), resolved: true };
      setEnvironment(previous => sameEnvironment(previous, next) ? previous : next);
    };
    const schedule = () => { if (active && frame === null) frame = requestAnimationFrame(read); };
    const observer = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element && record.target.closest("[data-tour-overlay]")))) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden", "open", "class", "style", "data-tour-blocker"] });
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true }); document.addEventListener("fullscreenchange", schedule); schedule();
    return () => { active = false; observer.disconnect(); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); document.removeEventListener("fullscreenchange", schedule); if (frame !== null) cancelAnimationFrame(frame); };
  }, [id, root, enabled]);
  return environment;
}

export function GuidedTourController({ owner, id, recordKey, root, isCurrent }: { owner: string; id: TourId; recordKey: string; root: RefObject<HTMLDivElement | null>; isCurrent?: () => boolean }) {
  const { getToken } = useAuth(), router = useRouter(), pathname = usePathname(), search = useSearchParams();
  const runOwned = useOwnerRequestScope(owner, getToken), { mutate } = useSWRConfig();
  const current = useRef(isCurrent); current.current = isCurrent;
  const lifetime = useRef({ active: true, pending: null as AbortController | null });
  const availability = useRef<TourAvailabilityScope>({ active: false, path: pathname, recordKey, current: () => lifetime.current.active && (!current.current || current.current()) });
  const wasObserving = useRef(false);
  const prefs = useApi<Preferences>(ONBOARDING_PREFERENCES_PATH, { keepPreviousData: false, revalidateOnFocus: false, shouldRetryOnError: false }, { timeoutMs: 15_000 });
  const data = !prefs.error && !prefs.isPreviousData && plainPreferences(prefs.data) ? prefs.data : null;
  const manual = search.getAll("tour").length === 1 && search.get("tour") === id;
  const done = data ? tourIsDone(id, data.toursDone) : false;
  const [activeTarget, setActiveTarget] = useState<string | null>(null), [closed, setClosed] = useState(false);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const replayHandled = useRef(false), attempted = useRef(false);
  const targetRef = useRef(activeTarget); targetRef.current = activeTarget;
  const routeAllowed = id === "today" ? pathname === "/app" : id === "overlay" ? pathname === "/settings"
    : pathname === "/app/game/" + encodeURIComponent(recordKey);
  const admitted = routeAllowed && (!current.current || current.current()) && !!data;
  const admission = useRef(admitted); admission.current = admitted;
  const observing = admitted && (!done || manual || !!activeTarget || pending) && (!closed || manual);
  if (wasObserving.current !== observing) {
    availability.current.active = false;
    availability.current = { active: observing, path: pathname, recordKey, current: () => lifetime.current.active && (!current.current || current.current()) };
    wasObserving.current = observing;
  }
  const probe = availability.current;
  const environment = useTourEnvironment(id, root, observing);

  useLayoutEffect(() => {
    const scope = lifetime.current; scope.active = true;
    const fullscreen = () => {
      if (!document.fullscreenElement) return;
      attempted.current = true;
      if (targetRef.current || scope.pending) setInterrupted(true);
      scope.pending?.abort(); setActiveTarget(null);
    };
    document.addEventListener("fullscreenchange", fullscreen); fullscreen();
    return () => { scope.active = false; availability.current.active = false; scope.pending?.abort(); document.removeEventListener("fullscreenchange", fullscreen); };
  }, []);
  useEffect(() => {
    const scope = probe;
    if (!observing || !scope.active || !scope.current() || !routeAllowed || !environment.resolved) return;
    void mutate<TourAvailability>(tourAvailabilityKey(owner, id), previous => {
      if (!scope.active || !scope.current()) return previous;
      return { available: environment.steps !== null, scope };
    }, { revalidate: false });
  }, [owner, id, routeAllowed, environment.steps, environment.resolved, observing, probe, mutate]);
  useEffect(() => {
    if (!manual) replayHandled.current = false;
    if (!admitted || !environment.steps || environment.blocked || !lifetime.current.active) {
      if (activeTarget) setInterrupted(true);
      setActiveTarget(null); return;
    }
    if (manual && !replayHandled.current) {
      replayHandled.current = true; attempted.current = true; setClosed(false); setError(null); setInterrupted(false);
      setActiveTarget(environment.steps[0].step.target);
      const query = new URLSearchParams(search.toString()); query.delete("tour");
      router.replace(pathname + (query.size ? "?" + query.toString() : "") + window.location.hash, { scroll: false });
    } else if (!manual && !done && !closed && !attempted.current) {
      attempted.current = true; setActiveTarget(environment.steps[0].step.target);
    }
  }, [admitted, environment, manual, done, closed, search, router, pathname, activeTarget]);
  useEffect(() => {
    if (activeTarget && environment.resolved && !environment.steps?.some(item => item.step.target === activeTarget)) { setActiveTarget(null); setInterrupted(true); }
  }, [activeTarget, environment]);

  const index = environment.steps?.findIndex(item => item.step.target === activeTarget) ?? -1;
  const active = index >= 0 ? environment.steps?.[index] : null;
  async function finish() {
    const scope = lifetime.current;
    if (!scope.active || scope.pending || !admitted || !active) return;
    const controller = new AbortController(); scope.pending = controller; setPending(true); setError(null);
    const assert = () => { if (!scope.active || !admission.current || scope.pending !== controller || controller.signal.aborted || current.current && !current.current()
      || !root.current?.contains(active.target) || !rendered(active.target) || hasBlocker()) throw new DOMException("Tour changed", "AbortError"); };
    try {
      await runOwned(owner, async (token, signal, assertOwner) => {
        assert();
        const readToken = async () => { assert(); const bearer = await token(); assert(); return bearer; };
        const saved = await apiCall<Preferences>(readToken, ONBOARDING_PREFERENCES_PATH,
          { method: "PUT", body: JSON.stringify({ toursDone: { [id]: TOURS[id].version } }), signal });
        assertOwner(); assert();
        if (!plainPreferences(saved) || !tourIsDone(id, saved.toursDone)) throw new Error("Your tour progress was not confirmed. Try again.");
        await prefs.mutate(value => { assertOwner(); assert(); return plainPreferences(value) ? { ...value,
          toursDone: { ...tourVersions(value.toursDone), [id]: Math.max(tourVersions(value.toursDone)[id] ?? 0, TOURS[id].version) } } : value;
        }, { revalidate: false });
        assertOwner(); assert(); setClosed(true); setActiveTarget(null);
      }, 15_000, controller.signal);
    } catch (failure) { if (scope.active && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Your tour progress could not be saved. Try again."); }
    finally { if (scope.pending === controller) scope.pending = null; if (scope.active) setPending(false); }
  }
  const readError = prefs.error || prefs.data !== undefined && !plainPreferences(prefs.data);
  if (manual && readError) return <div role="alert" className="rounded-xl border border-border bg-bg-surface p-3 text-body-sm">The tour could not load. <Button variant="ghost" size="sm" onClick={() => void prefs.mutate()}>Retry tour</Button></div>;
  const registrySteps: readonly TourStep[] = TOURS[id].steps;
  const guide = registrySteps.at(-1)?.help;
  if (admitted && !closed && (interrupted || manual && environment.resolved && (!environment.steps || environment.blocked))) return <p role="status" className="rounded-xl border border-border bg-bg-surface p-3 text-body-sm text-text-muted">
    {interrupted ? "The tour paused to leave your page controls available. It has not saved a completion." : !environment.steps ? "This tour is unavailable for the current layout." : "The tour is waiting while a dialog or build check-in is in view."}
    {guide ? <> <Link href={guide} className="inline-flex min-h-11 items-center text-accent underline">Read the guide</Link></> : null}
  </p>;
  if (!active || !admitted || environment.blocked || !environment.steps || closed || hasBlocker()) return null;
  const last = index === environment.steps.length - 1;
  const step = last && !active.step.help ? { ...active.step, help: registrySteps.at(-1)?.help } : active.step;
  return <Tour title={TOURS[id].title} step={step} target={active.target} index={index} total={environment.steps.length} pending={pending} error={error}
    canReveal={() => lifetime.current.active && admission.current && (!current.current || current.current()) && !hasBlocker()}
    onBack={() => { if (index > 0 && !pending) setActiveTarget(environment.steps![index - 1].step.target); }}
    onNext={() => { if (!pending && !last) setActiveTarget(environment.steps![index + 1].step.target); }}
    onFinish={() => void finish()} onSkip={() => void finish()} onTargetLost={() => { setActiveTarget(null); setInterrupted(true); }} />;
}
