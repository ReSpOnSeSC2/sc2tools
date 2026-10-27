"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { usePathname, useRouter } from "next/navigation";
import useSWR from "swr";
import { apiCall, useOwnerRequestScope } from "@/lib/clientApi";
import { TOURS, tourAvailabilityKey, tourReplayHref, tourUnavailable, type TourId, type TourAvailability } from "@/lib/tours";
import { Button, LinkButton } from "@/components/ui/Button";

/** Works in the full article, Settings Help and Help's drawer without private reads on mount. */
export function TakeATour() {
  const auth = useAuth(), owner = auth.isLoaded && auth.isSignedIn ? auth.userId : null;
  const pathname = usePathname(), identity = owner + ":" + pathname;
  const generation = useRef({ identity, active: true });
  if (generation.current.identity !== identity) { generation.current.active = false; generation.current = { identity, active: true }; }
  const scope = generation.current;
  useLayoutEffect(() => { scope.active = true; return () => { scope.active = false; }; }, [scope]);
  if (!auth.isLoaded) return <p role="status">Loading tours…</p>;
  if (!owner) return <div className="space-y-3"><p>Sign in to take a short tour of Today, your game breakdown or Overlay settings.</p><LinkButton href="/sign-in?redirect_url=%2Fhelp%2Ftake-a-tour" variant="secondary">Sign in to take a tour</LinkButton></div>;
  return <OwnerTours key={identity} owner={owner} isCurrent={() => generation.current === scope && scope.active} />;
}

function OwnerTours({ owner, isCurrent }: { owner: string; isCurrent: () => boolean }) {
  const { getToken } = useAuth(), router = useRouter(), runOwned = useOwnerRequestScope(owner, getToken);
  const pathname = usePathname();
  const today = useSWR<TourAvailability>(tourAvailabilityKey(owner, "today"), null);
  const game = useSWR<TourAvailability>(tourAvailabilityKey(owner, "game"), null);
  const overlay = useSWR<TourAvailability>(tourAvailabilityKey(owner, "overlay"), null);
  const availability = { today: today.data, game: game.data, overlay: overlay.data };
  const [pending, setPending] = useState<TourId | null>(null), [error, setError] = useState<string | null>(null);
  const lifetime = useRef({ active: true, request: null as AbortController | null });
  const current = useRef(isCurrent); current.current = isCurrent;
  useLayoutEffect(() => { const scope = lifetime.current; scope.active = true; return () => { scope.active = false; scope.request?.abort(); }; }, []);
  async function start(id: TourId) {
    const scope = lifetime.current;
    if (!scope.active || !current.current() || scope.request) return;
    if (id !== "game") { const href = tourReplayHref(id); if (href) router.push(href); return; }
    const controller = new AbortController(); scope.request = controller; setPending(id); setError(null);
    const assert = () => { if (!scope.active || !current.current() || scope.request !== controller || controller.signal.aborted) throw new DOMException("Tour list closed", "AbortError"); };
    try {
      await runOwned(owner, async (token, signal, assertOwner) => {
        assert();
        const readToken = async () => { assert(); const bearer = await token(); assert(); return bearer; };
        const page = await apiCall<{ items?: { gameId?: unknown }[] }>(readToken, "/v1/games?limit=1", { signal });
        assertOwner(); assert();
        const gameId = Array.isArray(page.items) && typeof page.items[0]?.gameId === "string" ? page.items[0].gameId : null;
        if (!gameId) throw new Error("Open this tour after a replay has been added to your account.");
        const href = tourReplayHref("game", gameId);
        if (!href) throw new Error("The latest replay could not be read. Try again.");
        assertOwner(); assert(); if (href) router.push(href);
      }, 15_000, controller.signal);
    } catch (failure) { if (scope.active && current.current() && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "This tour could not open. Try again."); }
    finally { if (scope.request === controller) scope.request = null; if (scope.active && current.current()) setPending(null); }
  }
  const visible = (Object.keys(TOURS) as TourId[]).filter(id => !tourUnavailable(availability[id], pathname));
  return <div className="space-y-3">
    <p className="text-body-sm text-text-muted">Replay a tour whenever you need it. Replaying keeps your saved progress. Tours wait for dialogs and visible build check-in cards.</p>
    {visible.length ? <ul className="space-y-3">{visible.map(id => <li key={id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3"><span className="min-w-0 flex-1 text-body-sm font-semibold">{TOURS[id].title}</span><Button variant="secondary" size="sm" disabled={pending !== null} onClick={() => void start(id)}>{pending === id ? "Opening…" : "Replay " + (id === "game" ? "game" : id === "today" ? "Today" : "Overlay") + " tour"}</Button></li>)}</ul> : <p>No tours are available for the current layout. You can still read the guides below.</p>}
    {error ? <p role="alert" className="text-body-sm text-danger">{error}</p> : null}
  </div>;
}
