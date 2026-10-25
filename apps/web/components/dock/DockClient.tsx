"use client";

/**
 * DockClient — the Stream Dock at /dock/[token]: an OBS Custom
 * Browser Dock / second-screen control panel for the multichat
 * overlay family.
 *
 * One page, two jobs:
 *   - WATCH: the same merged Twitch/Kick/YouTube/TikTok feed the OBS
 *     source renders (useMultiChat — the dock connects to the public
 *     chat endpoints itself, no extra server load).
 *   - CONTROL: the token's shared "stream studio" state (highlight
 *     pin, chat poll, goals, blocklist, session recap) via
 *     GET/POST /v1/multichat/:token/studio. Every POST returns the
 *     sanitized full state, which replaces local state — the dock
 *     never guesses what the server kept.
 *
 * Auth model: the token IS the auth, same as every overlay surface —
 * the dock URL is handed out next to the Browser Source URLs in
 * Settings and runs without a Clerk session (OBS docks have none).
 *
 * Responsive contract: narrow (an OBS dock is ~300px) stacks the
 * sections under a sticky jump-tab row; wide (second monitor) goes
 * two-column with chat on the left and controls on the right.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { API_BASE } from "@/lib/clientApi";
import { responseWasReplaced } from "@/components/overlay/overlayLinkStatus";
import {
  blockedUserSet,
  normalizeBlockedUser,
  excludeBlockedUsers,
  DEFAULT_APPEARANCE,
} from "@/lib/multichat/appearance";
import { useEngagementReporter } from "@/lib/multichat/useEngagementReporter";
import { useMultiChat } from "@/lib/multichat/useMultiChat";
import { useViewerCounts } from "@/lib/multichat/useViewerCounts";
import {
  DEFAULT_STUDIO_STATE,
  sanitizeStudioState,
  type StudioHighlight,
  type StudioState,
} from "@/lib/multichat/useStudioState";
import type { ChatMessage } from "@/lib/multichat/types";
import { useVoiceApplier } from "@/lib/useVoiceApplier";
import { inferVoiceGender } from "@/lib/voiceCatalog";
import { DockChat } from "./DockChat";
import { DockBlockedUsers } from "./DockBlockedUsers";
import { DOCK_BLOCKLIST_MAX, DOCK_CONFIG_REFRESH_MS } from "./dockConstants";
import { DockPollCard } from "./DockPollCard";
import { DockGoals } from "./DockGoals";
import { DockScenes, DockTimer } from "./DockScenes";
import { DockClips } from "./DockClips";
import { BuildProfileEditor } from "./BuildProfileEditor";
import { useEngagementState } from "@/lib/multichat/useEngagementState";
import { newestStudioSnapshot, useStudioUpdates } from "@/lib/multichat/useStudioUpdates";
import type { DockPost } from "./dockActions";
import { useDockPlatformConfig } from "./useDockPlatformConfig";
import styles from "./DockLayout.module.css";
import { Volume2 } from "lucide-react";
import { DOCK_SECTIONS, orderedDockSections, type DockSectionId } from "@/lib/dockLayout";
import { DockButton, DockToggle } from "./DockControls";
import { DockCopyText } from "./DockCopyText";
import { SectionCard } from "./SectionCard";
import { useDockLayout } from "./useDockLayout";
import { useDockScrollSpy } from "./useDockScrollSpy";
import { useDockSummaries } from "./useDockSummaries";
import { usePollTally } from "./usePollTally";
export { DockButton } from "./DockControls";
import { DockStatusHeader } from "./DockStatusHeader";
import { loadGameDesk } from "./dockLazyLoaders";
import { DockLazyPanel } from "./DockLazyPanel";
const loadScout = () => import("./DockScout").then(module => module.DockScout);
const loadTwitchAutomation = () => import("./DockTwitchAutomation").then(module => module.DockTwitchAutomation);
const loadSeries = () => import("./DockSeries").then(module => module.DockSeries);

/** Platform config re-read cadence — same as the OBS widget. */
const CONFIG_REFRESH_MS = DOCK_CONFIG_REFRESH_MS;
/** Recover initial moderation state promptly without hammering an outage. */
const STUDIO_RETRY_MS = [2_000, 5_000, 10_000, 30_000] as const;



export function DockClient({ token }: { token: string }) {
  const [invalidToken, setInvalidToken] = useState<string | null>(null);
  const [replaced, setReplaced] = useState(false);
  const activeTokenRef = useRef(token);
  activeTokenRef.current = token;
  const onInvalid = useCallback((wasReplaced = false) => {
    if (activeTokenRef.current === token) { setInvalidToken(token); setReplaced(wasReplaced); }
  }, [token]);
  if (invalidToken === token) return <div className="flex min-h-screen items-center justify-center p-4 text-text">
    <div role="alert" className="max-w-md space-y-3 rounded-lg border border-warning/40 bg-bg-surface p-5">
      <h1 className="text-h3 font-semibold">{replaced ? "This Dock URL was replaced" : "This Dock link no longer works"}</h1>
      <p>{replaced ? "Update this Dock in OBS using its replacement URL from Settings → Overlay." : "It was revoked or mistyped. Copy a fresh Dock URL from Settings → Overlay."}</p>
      <a href="/settings?tab=overlay" target="_blank" rel="noreferrer" className="text-accent-cyan underline">Open Overlay settings<span className="sr-only"> (opens in new tab)</span></a>
    </div>
  </div>;
  // Unmounting the active Dock stops every socket, platform request and retry
  // timer together. A different token starts with an empty authoritative state.
  return <ActiveDockClient key={token} token={token} onInvalid={onInvalid} />;
}

function ActiveDockClient({ token, onInvalid }: { token: string; onInvalid: (replaced?: boolean) => void }) {
  const { platforms, moderationAppearance, tts, loaded } =
    useDockPlatformConfig(token, onInvalid);
  const { messages, events, statuses } = useMultiChat({
    apiBase: API_BASE,
    token,
    config: platforms,
  });
  // Live audience size per platform + combined, read from the
  // platforms server-side (they send no CORS headers).
  const viewers = useViewerCounts(token, events);
  // Clip-moment log keeps its own boot fetch + 60s fallback. The lightweight
  // studio subscription below listens only for control-state updates.

  // Keep readiness tied to the token as part of the snapshot itself. That
  // makes a token change fail closed on its very first render instead of
  // briefly reusing the previous stream's blocklist and studio controls.
  const [studioSnapshot, setStudioSnapshot] = useState<{
    token: string | null;
    state: StudioState;
  }>({ token: null, state: DEFAULT_STUDIO_STATE });
  const studio = studioSnapshot.token === token
    ? studioSnapshot.state
    : DEFAULT_STUDIO_STATE;
  const studioSnapshotReady = studioSnapshot.token === token;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const studioMutationRef = useRef(0);
  const studioFetchRef = useRef(0);
  const latestStudioRef = useRef<{ token: string; state: StudioState } | null>(null);
  const postingRef = useRef(false);
  const lastFailedActionRef = useRef<(() => Promise<StudioState | null>) | null>(null);
  const currentTokenRef = useRef(token);
  currentTokenRef.current = token;

  const studioUrl = `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/studio`;

  const adoptStudioSnapshot = useCallback((next: StudioState) => {
    const latest = latestStudioRef.current?.token === token ? latestStudioRef.current.state : null;
    const selected = newestStudioSnapshot(latest, next);
    latestStudioRef.current = { token, state: selected };
    if (selected === next) setStudioSnapshot({ token, state: selected });
    return selected;
  }, [token]);

  const updates = useStudioUpdates(token, (next) => {
    // Invalidate any GET that began before this authoritative live update.
    studioMutationRef.current += 1;
    adoptStudioSnapshot(next);
  });
  const connectionStatus = updates?.status ?? "connected";
  const { summary: engagement, loaded: engagementReady } = useEngagementState(token, updates?.engagementEvent ?? null);
  useEffect(() => { if (connectionStatus === "invalid" || connectionStatus === "replaced") onInvalid(connectionStatus === "replaced"); }, [connectionStatus, onInvalid]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryAttempt = 0;
    const load = async () => {
      const mutationSequence = studioMutationRef.current;
      const fetchSequence = ++studioFetchRef.current;
      try {
        const res = await fetch(studioUrl, { cache: "no-store" });
        if (!cancelled && res.status === 401) { const replaced = await responseWasReplaced(res); if (!cancelled) onInvalid(replaced); return; }
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (
          cancelled
          || mutationSequence !== studioMutationRef.current
          || fetchSequence !== studioFetchRef.current
          || postingRef.current
          || !body
          || typeof body !== "object"
          || Array.isArray(body)
        ) return;
        adoptStudioSnapshot(sanitizeStudioState(body));
      } catch {
        /* Keep moderation closed until an authoritative snapshot arrives. */
      } finally {
        if (!cancelled) {
          // A live update or successful action can also establish readiness.
          // Keep the normal fallback cadence once any authoritative snapshot
          // exists, including after a later transient refresh failure.
          const ready = latestStudioRef.current?.token === token;
          const delay = ready
            ? CONFIG_REFRESH_MS
            : STUDIO_RETRY_MS[Math.min(retryAttempt++, STUDIO_RETRY_MS.length - 1)];
          timer = setTimeout(load, delay);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [studioUrl, token, adoptStudioSnapshot, onInvalid]);

  const blockedUsers = useMemo(
    () => blockedUserSet(
      { ...DEFAULT_APPEARANCE, ...moderationAppearance },
      studio.blockedUsers,
    ),
    [moderationAppearance, studio.blockedUsers],
  );
  const moderatedMessages = useMemo(
    () => loaded && studioSnapshotReady
      ? excludeBlockedUsers(messages, blockedUsers)
      : [],
    [blockedUsers, loaded, messages, studioSnapshotReady],
  );
  const moderatedEvents = useMemo(
    () => loaded && studioSnapshotReady
      ? excludeBlockedUsers(events, blockedUsers)
      : [],
    [blockedUsers, events, loaded, studioSnapshotReady],
  );
  useEngagementReporter(token, moderatedMessages, moderatedEvents);

  // Every action goes through here: POST the partial, adopt the
  // sanitized full state the server returns. Disabled-while-in-flight
  // beats optimistic guessing inside OBS — round trips are local-fast.
  const postStudio: DockPost = useCallback(
    async function saveStudio(patch: Record<string, unknown>, retry?: () => Promise<StudioState | null>): Promise<StudioState | null> {
      if (postingRef.current || latestStudioRef.current?.token !== token) return null;
      postingRef.current = true;
      studioMutationRef.current += 1;
      const mutationSequence = studioMutationRef.current;
      setBusy(true);
      setError(null);
      lastFailedActionRef.current = retry ?? (() => saveStudio(patch));
      try {
        const res = await fetch(studioUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
          cache: "no-store",
        });
        if (res.status === 401) { const replaced = await responseWasReplaced(res); onInvalid(replaced); return null; }
        if (!res.ok) {
          if (currentTokenRef.current === token) setError(`Save failed (${res.status}) — try again.`);
          return null;
        }
        const body: unknown = await res.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          if (currentTokenRef.current === token) setError("Save failed — the server returned an invalid response.");
          return null;
        }
        const saved = sanitizeStudioState(body);
        if (currentTokenRef.current !== token) return null;
        lastFailedActionRef.current = null;
        const latest = latestStudioRef.current?.token === token ? latestStudioRef.current.state : null;
        // Two distinct writes can share one millisecond. A live event that
        // arrived during this request wins a timestamp tie with its response.
        if (latest && studioMutationRef.current !== mutationSequence && latest.updatedAt && saved.updatedAt
          && Date.parse(latest.updatedAt) === Date.parse(saved.updatedAt)) return latest;
        return adoptStudioSnapshot(saved);
      } catch {
        if (currentTokenRef.current === token) setError("Save failed — check the connection and try again.");
        return null;
      } finally {
        postingRef.current = false;
        setBusy(false);
      }
    },
    [studioUrl, token, adoptStudioSnapshot, onInvalid],
  );

  const postStudioAction = postStudio;

  const highlightMessage = useCallback(
    (m: ChatMessage) =>
      postStudio({
        highlight: { platform: m.platform, user: m.user, text: m.text },
      }),
    [postStudio],
  );

  // ── Read highlights aloud (TTS on THIS device — the dock is what
  // the streamer is touching, so the tap doubles as the autoplay
  // gesture). "Auto-read" speaks each newly pinned message; the pin
  // that's already on screen when the dock opens stays silent.
  // The dock reads aloud with the SAME voice the streamer chose for
  // chat TTS. It used to construct a bare utterance, which meant the
  // engine default spoke — Microsoft David on Windows — no matter what
  // was selected.
  const applyVoice = useVoiceApplier(
    useMemo(
      () => ({
        name: tts.voiceName || undefined,
        gender: tts.voiceName ? inferVoiceGender(tts.voiceName) : undefined,
      }),
      [tts.voiceName],
    ),
  );
  const speakHighlight = useCallback(
    (h: StudioHighlight) => {
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(`${h.user} says: ${h.text}`);
        u.rate = tts.rate;
        u.volume = tts.volume / 100;
        applyVoice(u);
        window.speechSynthesis.speak(u);
      } catch {
        /* speech backend hiccup — stay silent */
      }
    },
    [applyVoice, tts.rate, tts.volume],
  );

  const [autoRead, setAutoRead] = useState(false);
  useEffect(() => {
    try { setAutoRead(window.localStorage.getItem("dock:autoReadHighlights") === "1"); } catch { /* Session-only preference. */ }
  }, []);
  const toggleAutoRead = (on: boolean) => {
    setAutoRead(on);
    try {
      window.localStorage.setItem("dock:autoReadHighlights", on ? "1" : "0");
    } catch {
      /* storage unavailable — session-only toggle */
    }
  };

  const lastHighlightKeyRef = useRef<string | null | undefined>(undefined);
  const autoReadRef = useRef(autoRead);
  autoReadRef.current = autoRead;
  useEffect(() => {
    const h = studio.highlight;
    const key = h ? `${h.platform}:${h.user}:${h.atMs}:${h.text}` : null;
    const prev = lastHighlightKeyRef.current;
    lastHighlightKeyRef.current = key;
    // undefined = first render — adopt without speaking.
    if (prev === undefined || key === prev || !h) return;
    if (autoReadRef.current) speakHighlight(h);
  }, [studio.highlight, speakHighlight]);

  const [blockUndo, setBlockUndo] = useState<{ user: string; at: number } | null>(null);
  useEffect(() => {
    if (!blockUndo) return;
    const timer = setTimeout(() => setBlockUndo(null), 6000);
    return () => clearTimeout(timer);
  }, [blockUndo]);
  const editBlocklist = useCallback(async (user: string, block: boolean): Promise<StudioState | null> => {
    if (!studioSnapshotReady) return null;
    const retry = () => {
      const latest = latestStudioRef.current;
      if (latest?.token !== token) return Promise.resolve(null);
      const current = latest.state.blockedUsers;
      const remaining = current.filter((entry) => normalizeBlockedUser(entry) !== normalizeBlockedUser(user));
      if (block && remaining.length >= DOCK_BLOCKLIST_MAX) return Promise.resolve(null);
      return postStudio({ blockedUsers: block ? [...remaining, user] : remaining }, retry);
    };
    return retry();
  }, [postStudio, studioSnapshotReady, token]);
  const blockUser = async (user: string) => {
    const saved = await editBlocklist(user, true);
    if (saved?.blockedUsers.some((entry) => normalizeBlockedUser(entry) === normalizeBlockedUser(user))) setBlockUndo({ user, at: Date.now() });
  };
  const unblockUser = async (user: string) => {
    const saved = await editBlocklist(user, false);
    if (saved && blockUndo && normalizeBlockedUser(blockUndo.user) === normalizeBlockedUser(user)) setBlockUndo(null);
  };

  const [dockUrl, setDockUrl] = useState("");
  useEffect(() => { setDockUrl(window.location.href); }, []);
  const { layout, setOpen, togglePin, setBrollOpen, reset } = useDockLayout();
  const [seriesSummary, setSeriesSummary] = useState({ summary: "No active series", active: false });
  const receiveSeriesSummary = useCallback((summary: string, active: boolean) => setSeriesSummary(old => old.summary === summary && old.active === active ? old : { summary, active }), []);
  const ordered = orderedDockSections(layout);
  const [headerHeight, setHeaderHeight] = useState(64);
  const { active, jumpTo } = useDockScrollSpy(setOpen, headerHeight);
  const tally = usePollTally(moderatedMessages, studio.poll);
  const summaries = useDockSummaries(studio, studioSnapshotReady, platforms, loaded,
    tally?.total ?? 0, engagement.clipMoments.length, engagementReady);
  summaries["dock-series"] = seriesSummary;
  const panels: Record<DockSectionId, ReactNode> = {
    "dock-game": <><DockLazyPanel label="game desk" loader={loadGameDesk} componentProps={{ token, live: updates?.liveGame ?? null, lastLiveAt: updates?.lastLiveAt ?? null, gameStatus: updates?.gameStatus ?? null, session: updates?.session ?? null, studio, engagement, ready: studioSnapshotReady && engagementReady, busy, onPost: postStudioAction }} /><DockLazyPanel label="Twitch prediction controls" loader={loadTwitchAutomation} componentProps={{ token, onInvalid }} /></>,
    "dock-series": <DockLazyPanel label="Series controls" loader={loadSeries} componentProps={{ token, rawEvent: updates?.seriesEvent, live: updates?.liveGame ?? null, lastOpponent: updates?.lastOpponent ?? null, onInvalid, onSummary: receiveSeriesSummary }} />,
    "dock-scout": <DockLazyPanel label="live scouting" loader={loadScout} componentProps={{ live: updates?.liveGame ?? null, lastUpdatedAt: updates?.lastLiveAt ?? null }} />,
    "dock-chat": <>
<DockChat embedded
            loaded={loaded}
            studioReady={studioSnapshotReady}
            platforms={platforms}
            messages={moderatedMessages}
            events={moderatedEvents}
            statuses={statuses}
            blockedUsers={[...blockedUsers]}
            busy={busy}
            blocklistFull={studio.blockedUsers.length >= DOCK_BLOCKLIST_MAX}
            viewers={viewers}
            onHighlight={(m) => void highlightMessage(m)}
            onBlock={(user) => void blockUser(user)}
          />
          {blockUndo ? <p role="status" className="mt-2 text-caption text-success">Blocked {blockUndo.user} · <DockButton type="button" disabled={busy || !studioSnapshotReady} onClick={() => void unblockUser(blockUndo.user)} className="underline">Undo</DockButton></p> : null}
          <DockBlockedUsers users={studio.blockedUsers} managedUsers={moderationAppearance.blockedUsers.split(",").map((u) => u.trim()).filter(Boolean)} ready={studioSnapshotReady} busy={busy} onUnblock={(user) => void unblockUser(user)} />
    </>,
    "dock-highlight": <>
{studio.highlight ? (
                <div className="space-y-2">
                  <div className="rounded-md border border-accent-cyan/40 bg-accent-cyan/10 px-2.5 py-2">
                    <div className="text-micro font-semibold uppercase tracking-wider text-accent-cyan">
                      {studio.highlight.platform} · {studio.highlight.user}
                    </div>
                    <div className="mt-1 break-words text-caption text-text">
                      {studio.highlight.text}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <DockButton
                      onClick={() =>
                        studio.highlight && speakHighlight(studio.highlight)
                      }
                    >
                      <Volume2 aria-hidden className="h-4 w-4" /> Read aloud
                    </DockButton>
                    <DockButton
                      disabled={busy}
                      onClick={() => void postStudio({ highlight: null })}
                    >
                      Clear highlight
                    </DockButton>
                  </div>
                </div>
              ) : (
                <p className="text-caption text-text-dim">
                  Nothing pinned. Tap a chat message's <b>Highlight</b> to
                  pin it on stream.
                </p>
              )}
              <div className="mt-2 flex items-center gap-2 text-caption text-text-muted">
                <DockToggle checked={autoRead} onChange={toggleAutoRead} label="Auto-read new highlights" />
                <span>Auto-read new highlights (spoken on this device)</span>
              </div>
    </>,
    "dock-scenes": <>
<DockScenes
                token={token}
                brollOpen={layout.brollOpen}
                onBrollOpenChange={setBrollOpen}
                studioReady={studioSnapshotReady}
                scene={studio.scene}
                broll={studio.broll}
                busy={busy}
                streamStartMs={studio.streamStartMs}
                onPost={postStudioAction}
              />
    </>,
    "dock-build-profile": <>
<BuildProfileEditor
                key={token}
                profile={studio.buildProfile}
                busy={busy}
                ready={studioSnapshotReady}
                onPost={postStudio}
              />
    </>,
    "dock-timer": <>
<DockTimer
                studioReady={studioSnapshotReady}
                timer={studio.timer}
                busy={busy}
                onPost={postStudioAction}
              />
    </>,
    "dock-poll": <>
<DockPollCard
                token={token}
                studioReady={studioSnapshotReady}
                poll={studio.poll}
                messages={moderatedMessages}
                busy={busy}
                onPost={postStudioAction}
              />
    </>,
    "dock-goals": <>
<DockGoals
                studioReady={studioSnapshotReady}
                goals={studio.goals}
                busy={busy}
                onPost={postStudioAction}
              />
    </>,
    "dock-clips": <>
<DockClips
                studioReady={studioSnapshotReady}
                moments={engagement.clipMoments}
                streamStartMs={studio.streamStartMs}
                vodUrl={studio.vodUrl}
                busy={busy}
                onPost={postStudioAction}
              />
    </>,
    "dock-actions": <>
<div className="space-y-3">
                <DockButton
                  disabled={busy || !studioSnapshotReady}
                  onClick={() => void postStudio({ recap: true })}
                >
                  Fire session recap
                </DockButton>
                <p className="text-micro text-text-dim">
                  Plays the session recap on your overlay.
                </p>
                <div className="border-t border-border pt-3">
                  <a
                    href="/settings?tab=overlay"
                    target="_blank"
                    rel="noreferrer"
                    className="text-caption text-accent-cyan underline-offset-2 hover:underline"
                  >
                    Open Overlay settings
                  </a>
                  <p className="mt-2 text-micro text-text-dim">
                    Add this page as an OBS custom browser dock: Docks →
                    Custom Browser Docks, paste the URL.
                  </p>
                  <div className="mt-2"><DockCopyText value={dockUrl} label="Copy dock URL" disabled={!dockUrl} /></div>
                </div>
              </div>
    </>
  };

  return (
    <div className={`${styles.root} mx-auto min-h-screen w-full max-w-6xl p-2 font-sans text-text sm:p-3`} style={{ "--dock-sticky-height": `${headerHeight}px` } as CSSProperties}>
      <DockStatusHeader token={token} studio={studio} ready={studioSnapshotReady} live={updates?.liveGame ?? null} lastLiveAt={updates?.lastLiveAt ?? null} session={updates?.session ?? null} status={connectionStatus} onHeight={setHeaderHeight}>
      {/* Narrow-mode sticky jump tabs — the OBS dock has no room for
          a permanent two-column layout. */}
      <nav aria-label="Dock sections" className="flex items-center gap-1 overflow-x-auto py-1.5 lg:hidden">
        {DOCK_SECTIONS.map((s) => (
          <DockButton
            key={s.id}
            type="button"
            onClick={() => jumpTo(s.id)}
            aria-current={active === s.id ? "location" : undefined}
            className={`shrink-0 whitespace-nowrap px-2 text-caption ${active === s.id ? "underline underline-offset-4" : ""}`}
            variant={active === s.id ? "secondary" : "ghost"}
          >
            {s.label}
          </DockButton>
        ))}
      </nav>
      </DockStatusHeader>
      <div className="mb-2 flex justify-end"><DockButton onClick={reset}>Reset layout</DockButton></div>

      {connectionStatus === "reconnecting" ? <p role="status" className="mb-2 text-caption text-text-muted">Reconnecting to SC2 Tools…</p> : null}

      {error ? (
        <div role="alert" className="mb-2 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-caption text-danger">
          {error}
          <div className="mt-1 flex gap-2"><DockButton onClick={() => void lastFailedActionRef.current?.()}>Retry</DockButton><DockButton onClick={() => { setError(null); lastFailedActionRef.current = null; }}>Dismiss</DockButton></div>
        </div>
      ) : null}

      {/* A single keyed parent preserves each panel's draft when pin order changes. */}
      <div className={`${styles.grid} grid min-w-0 gap-3`} data-chat-pinned={layout.pinned.includes("dock-chat")} style={{ "--dock-controls": Math.max(1, DOCK_SECTIONS.length - 1 - layout.pinned.filter(id => id !== "dock-chat").length) } as CSSProperties}>
        {ordered.map(id => {
          const section = DOCK_SECTIONS.find(value => value.id === id)!;
          return <SectionCard key={id} id={id} title={section.label} {...summaries[id]}
            open={!layout.collapsed.includes(id)} pinned={layout.pinned.includes(id)}
            onToggle={() => setOpen(id, layout.collapsed.includes(id))} onPin={() => togglePin(id)}>
            {panels[id]}
          </SectionCard>;
        })}
      </div>

    </div>
  );
}
