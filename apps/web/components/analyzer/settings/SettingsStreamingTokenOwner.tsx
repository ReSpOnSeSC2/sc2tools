"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import useSWR, { unstable_serialize, useSWRConfig } from "swr";
import { apiCall, boundedApiRequest, type ClientApiError } from "@/lib/clientApi";
import type { SettingsOverlayPane } from "@/lib/settingsRegistry";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { OverlayTokenManager, type OverlayTokenConfirmation } from "./OverlayTokenManager";
import type { OverlayToken } from "./OverlayTokenHeader";
import { useSettingsContext } from "./SettingsContext";

type TokenList = { items: OverlayToken[] };
type Lifetime = { active: boolean };
type AmbiguityGeneration = { mayClear: boolean };
type AmbiguityMarker = { blocked: true; generation: AmbiguityGeneration };
function isAmbiguityMarker(value: unknown): value is AmbiguityMarker {
  return !!value && typeof value === "object" && "blocked" in value && value.blocked === true && "generation" in value && !!value.generation && typeof value.generation === "object";
}
type Credential = Lifetime & { key: number; token: string; pending: boolean; replacement?: string };
type StreamingTokens = {
  ownerId: string;
  token: OverlayToken;
  credential: Credential;
  section: SettingsOverlayPane;
  getToken: () => Promise<string | null>;
  isCurrent: () => boolean;
  refresh: (preferred?: string) => Promise<unknown>;
  patchToken: (patch: Partial<OverlayToken>) => void;
};
const StreamingContext = createContext<StreamingTokens | null>(null);
export function useSettingsStreamingToken(): StreamingTokens {
  const value = useContext(StreamingContext);
  if (!value) throw new Error("Streaming settings require an admitted token owner");
  return value;
}

/** Loaded by SettingsShell only for an admitted Overlay or Chat destination. */
export function SettingsStreamingTokenOwner({ children, section }: { children: ReactNode; section: SettingsOverlayPane }) {
  const auth = useAuth();
  const ownerId = auth.isLoaded && auth.isSignedIn && auth.userId ? auth.userId : null;
  const generation = useMemo(() => ({ ownerId, active: true }), [ownerId]);
  const latest = useRef(generation); latest.current = generation;
  const readToken = useRef(auth.getToken); readToken.current = auth.getToken;
  useLayoutEffect(() => {
    generation.active = true;
    return () => { generation.active = false; };
  }, [generation]);
  const current = useCallback(() => generation.active && latest.current === generation, [generation]);
  const getToken = useCallback(async () => {
    if (!current()) throw new Error("Account changed");
    const value = await readToken.current();
    if (!current()) throw new Error("Account changed");
    return value;
  }, [current]);
  if (!ownerId) return <Skeleton rows={3} />;
  return <StreamingOwner key={ownerId} ownerId={ownerId} currentOwner={current} getToken={getToken} section={section}>{children}</StreamingOwner>;
}

function StreamingOwner({ ownerId, currentOwner, getToken, section, children }: {
  ownerId: string; currentOwner: () => boolean; getToken: () => Promise<string | null>;
  section: SettingsOverlayPane; children: ReactNode;
}) {
  const { cache } = useSWRConfig();
  // This metadata contains no token, profile, response body or other private
  // payload. It survives leaving the two streaming tabs in this SWR session.
  const ambiguityKey = unstable_serialize(["settings-streaming-create-ambiguity", ownerId]);
  const { mutate } = useSWR<TokenList>(["authenticated-api", ownerId, "/v1/overlay-tokens"], null, {
    revalidateOnMount: false, revalidateOnFocus: false, revalidateOnReconnect: false,
  });
  const dirtyContext = useSettingsContext();
  const dirty = dirtyContext.isDirty("overlay") || dirtyContext.isDirty("chat");
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const lifetime = useMemo<Lifetime>(() => ({ active: true }), []);
  const read = useRef<AbortController | null>(null);
  const creation = useRef<AbortController | null>(null);
  const readRevision = useRef(0);
  const attemptedDefault = useRef(false);
  const [list, setList] = useState<TokenList | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [phase, setPhase] = useState<"loading" | "ready" | "creating" | "unknown" | "error">("loading");
  const [error, setError] = useState("");
  const [managerBusy, setManagerBusy] = useState(false);
  const managerBusyRef = useRef(false);
  const [checkedUnknown, setCheckedUnknown] = useState(false);
  const statusChecked = useRef(false);
  const ambiguityGeneration = useRef<AmbiguityGeneration | null>(null);
  const automaticBlocked = useCallback(() => {
    const stored: unknown = cache.get(ambiguityKey)?.data;
    return stored === true || isAmbiguityMarker(stored);
  }, [cache, ambiguityKey]);
  const markAmbiguous = useCallback(() => {
    // A later known operation cannot erase an earlier unresolved outcome.
    // The identity also fences another instance using this same owner cache.
    const generation = { mayClear: !automaticBlocked() }; ambiguityGeneration.current = generation;
    cache.set(ambiguityKey, { data: { blocked: true, generation } satisfies AmbiguityMarker }); statusChecked.current = false; setCheckedUnknown(false);
    return generation;
  }, [cache, ambiguityKey, automaticBlocked]);
  const ownsAmbiguity = useCallback((generation: object) => {
    const stored: unknown = cache.get(ambiguityKey)?.data;
    return ambiguityGeneration.current === generation && ambiguityGeneration.current.mayClear && isAmbiguityMarker(stored) && stored.generation === generation;
  }, [cache, ambiguityKey]);
  const credential = useRef<Credential | null>(null);
  const sequence = useRef(0);
  const current = useCallback(() => lifetime.active && currentOwner(), [lifetime, currentOwner]);
  const retireCredential = useCallback(() => {
    if (credential.current) credential.current.active = false;
    credential.current = null;
  }, []);
  const items = (list?.items ?? []).filter(item => !item.revokedAt || item.rotationPending);
  const statusView = useRef({ phase, empty: !!list && items.length === 0 }); statusView.current = { phase, empty: !!list && items.length === 0 };
  const active = items.find(item => item.token === selected) ?? items[0] ?? null;
  const canRender = phase === "ready" && !managerBusy && active && !active.rotationPending && !active.revokedAt;
  if (!canRender || credential.current?.token !== active.token || credential.current.pending !== !!active.rotationPending || credential.current.replacement !== active.replacedBy) {
    retireCredential();
    if (canRender) credential.current = { active: true, key: ++sequence.current, token: active.token, pending: !!active.rotationPending, replacement: active.replacedBy };
  }

  const refresh = useCallback(async (preferred?: string, gate = true, confirmation?: OverlayTokenConfirmation) => {
    if (!current()) return;
    const controller = new AbortController();
    read.current?.abort(); read.current = controller;
    const revision = ++readRevision.current;
    const admitted = () => current() && read.current === controller && revision === readRevision.current && !controller.signal.aborted;
    if (gate) { setPhase("loading"); retireCredential(); }
    setError("");
    try {
      // A real, non-deduped read owns this mount/generation. Warm SWR data,
      // including an earlier empty list, is never default-creation permission.
      const result = await boundedApiRequest(signal => apiCall<TokenList>(getToken, "/v1/overlay-tokens", { signal }), 15_000, controller.signal);
      if (!admitted()) return;
      if (!result || !Array.isArray(result.items) || !result.items.every(item => item && typeof item.token === "string" && item.token.length > 0 && typeof item.label === "string" && typeof item.createdAt === "string")) throw new Error("Invalid token status response");
      await mutate(previous => admitted() ? result : previous, { revalidate: false });
      if (!admitted()) return;
      setList(result);
      statusChecked.current = true;
      setCheckedUnknown(true);
      if (confirmation && ownsAmbiguity(confirmation.ambiguity) && confirmation.predecessor === selectedRef.current) {
        const matchedHandle = confirmation.returnedToken && result.items.some(item => item.token === confirmation.returnedToken && !item.revokedAt && !item.rotationPending);
        const confirmedRevocation = confirmation.action === "revoke" && result.items.every(item => item.token !== confirmation.predecessor || !!item.revokedAt);
        if (confirmation.action !== "revoke" && matchedHandle || confirmedRevocation) cache.set(ambiguityKey, { data: false });
      }
      const visible = result.items.filter(item => !item.revokedAt || item.rotationPending);
      const next = preferred ?? selectedRef.current;
      setSelected(visible.some(item => item.token === next) ? next : visible[0]?.token ?? null);
      setPhase(visible.length || !automaticBlocked() ? "ready" : "unknown");
      return result;
    } catch (failure) {
      if (!admitted()) return;
      setError((failure as ClientApiError)?.message || "Couldn't check your streaming tokens.");
      if (gate) setPhase(automaticBlocked() ? "unknown" : "error");
      throw failure;
    } finally {
      if (read.current === controller) read.current = null;
    }
  }, [current, getToken, mutate, retireCredential, automaticBlocked, ownsAmbiguity, cache, ambiguityKey]);

  const create = useCallback(async (automatic: boolean) => {
    if (!current() || creation.current || read.current || managerBusyRef.current || dirtyRef.current ||
        !statusView.current.empty || statusView.current.phase === "loading" || statusView.current.phase === "creating" ||
        automatic && (automaticBlocked() || attemptedDefault.current) ||
        !automatic && automaticBlocked() && !statusChecked.current) return;
    if (automatic) attemptedDefault.current = true;
    const controller = new AbortController(); creation.current = controller;
    const admitted = () => current() && creation.current === controller && !controller.signal.aborted;
    let dispatched = false;
    let ambiguity: object | null = null;
    setPhase("creating"); setError(""); retireCredential();
    try {
      const result = await boundedApiRequest(signal => apiCall<{ token?: string }>(async () => {
        const bearer = await getToken();
        if (!admitted() || signal.aborted) throw new Error("Account changed");
        // Write BEFORE dispatch, so unmount/lost ACK cannot silently remint.
        dispatched = true; ambiguity = markAmbiguous();
        return bearer;
      }, "/v1/overlay-tokens", { method: "POST", body: JSON.stringify({ label: "Default" }), signal }), 15_000, controller.signal);
      if (!admitted()) return;
      const createdToken = typeof result?.token === "string" && result.token.length > 0 && result.token.trim() === result.token ? result.token : undefined;
      const confirmed = await refresh(createdToken);
      // A confirmed success plus a fresh, nonempty list resolves this attempt.
      // Unknown attempts keep the metadata even after an empty status read.
      if (admitted() && ambiguity && ownsAmbiguity(ambiguity) && createdToken && confirmed?.items.some(item => item.token === createdToken && !item.revokedAt && !item.rotationPending)) cache.set(ambiguityKey, { data: false });
    } catch (failure) {
      if (!admitted()) return;
      setError((failure as ClientApiError)?.message || "Token creation couldn't be confirmed.");
      setPhase(dispatched ? "unknown" : "error");
    } finally {
      if (creation.current === controller) creation.current = null;
    }
  }, [current, getToken, refresh, retireCredential, automaticBlocked, markAmbiguous, ownsAmbiguity, cache, ambiguityKey]);

  useLayoutEffect(() => {
    lifetime.active = true;
    return () => {
      lifetime.active = false; retireCredential();
      read.current?.abort(); creation.current?.abort();
    };
  }, [lifetime, retireCredential]);
  useEffect(() => { void refresh().catch(() => undefined); }, [refresh]);
  useEffect(() => {
    if (phase === "ready" && list && items.length === 0 && !dirty && !automaticBlocked()) void create(true);
  }, [phase, list, items.length, dirty, create, automaticBlocked]);

  const selectToken = (value: string) => {
    if (!current() || dirtyRef.current || managerBusyRef.current || !items.some(item => item.token === value)) return;
    retireCredential(); setSelected(value);
  };
  const markUnknown = () => {
    if (!current()) return;
    markAmbiguous(); retireCredential(); setPhase("unknown");
  };
  const busyChanged = (busy: boolean) => {
    if (!current()) return;
    managerBusyRef.current = busy;
    if (busy) retireCredential();
    setManagerBusy(busy);
  };

  const status = phase === "loading" || phase === "creating" ? <Skeleton rows={3} /> : phase === "unknown" || phase === "error" || !active ? <Card className="space-y-3">
    <p role={error ? "alert" : "status"} className="text-body text-text">{phase === "unknown" ? "A token change may have completed. Check status before creating another token." : error || "No active streaming token was found."}</p>
    {error && phase === "unknown" ? <p className="text-caption text-text-muted">{error}</p> : null}
    <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => void refresh().catch(() => undefined)}>Check token status</Button>
      {list && !items.length && (phase !== "unknown" || checkedUnknown) ? <Button disabled={dirty} onClick={() => void create(false)}>Create a token explicitly</Button> : null}</div>
  </Card> : null;
  const lease = credential.current;
  const value: StreamingTokens | null = lease ? {
    ownerId, token: active!, credential: lease, section, getToken: async () => {
      if (!current() || !lease.active || credential.current !== lease) throw new Error("Selected token changed");
      const bearer = await getToken();
      if (!current() || !lease.active || credential.current !== lease) throw new Error("Selected token changed");
      return bearer;
    },
    isCurrent: () => current() && lease.active && credential.current === lease,
    refresh: preferred => current() && lease.active && credential.current === lease ? refresh(preferred, false) : Promise.resolve(undefined),
    patchToken: patch => {
      if (!current() || !lease.active || credential.current !== lease) return;
      setList(previous => current() && lease.active && credential.current === lease && previous ? { items: previous.items.map(item => item.token === lease.token ? { ...item, ...patch } : item) } : previous);
      void mutate(previous => current() && lease.active && credential.current === lease && previous ? { items: previous.items.map(item => item.token === lease.token ? { ...item, ...patch } : item) } : previous, { revalidate: false });
    },
  } : null;
  return <div className="space-y-5">
    {active ? <section aria-label="Shared streaming token controls"><OverlayTokenManager items={items} selected={active} onSelect={selectToken} onRefresh={refresh} onBusyChange={busyChanged} onUnknownOutcome={markUnknown} onMutationDispatched={markAmbiguous} statusPending={phase !== "ready"} /></section> : null}
    {status}
    {value ? <StreamingContext.Provider value={value}><div key={lease!.key}>{children}</div></StreamingContext.Provider> : null}
  </div>;
}
