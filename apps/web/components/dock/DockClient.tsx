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

import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "@/lib/clientApi";
import { useMultiChat } from "@/lib/multichat/useMultiChat";
import {
  DEFAULT_STUDIO_STATE,
  sanitizeStudioState,
  type StudioState,
} from "@/lib/multichat/useStudioState";
import type { ChatMessage, MultichatConfig } from "@/lib/multichat/types";
import { DockChat } from "./DockChat";
import { DockPoll } from "./DockPoll";
import { DockGoals } from "./DockGoals";

/** Platform config re-read cadence — same as the OBS widget. */
const CONFIG_REFRESH_MS = 60_000;

/**
 * Platform entries only, identity-stable across refetches — same
 * contract as the widget's config loader: useMultiChat reconnects
 * every engine when the object identity changes, so styling blobs
 * must never ride along and equal payloads must not mint new objects.
 */
function usePlatformConfig(token: string): {
  platforms: MultichatConfig | null;
  loaded: boolean;
} {
  const [platforms, setPlatforms] = useState<MultichatConfig | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let lastJson = "";
    const load = async () => {
      try {
        const res = await fetch(
          `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/config`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const body = (await res.json()) as { config?: MultichatConfig };
        if (cancelled) return;
        const {
          appearance: _appearance,
          tts: _tts,
          sound: _sound,
          ...next
        } = body?.config ?? {};
        const json = JSON.stringify(next);
        if (json !== lastJson) {
          lastJson = json;
          setPlatforms(next);
        }
      } catch {
        /* transient — next tick retries */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    const timer = setInterval(load, CONFIG_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token]);

  return { platforms, loaded };
}

const SECTIONS = [
  { id: "dock-chat", label: "Chat" },
  { id: "dock-highlight", label: "Highlight" },
  { id: "dock-poll", label: "Poll" },
  { id: "dock-goals", label: "Goals" },
  { id: "dock-actions", label: "Actions" },
] as const;

export function DockClient({ token }: { token: string }) {
  const { platforms, loaded } = usePlatformConfig(token);
  const { messages, statuses } = useMultiChat({
    apiBase: API_BASE,
    token,
    config: platforms,
  });

  const [studio, setStudio] = useState<StudioState>(DEFAULT_STUDIO_STATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const studioUrl = `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/studio`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(studioUrl, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        setStudio(sanitizeStudioState(await res.json()));
      } catch {
        /* the first action's response re-syncs */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studioUrl]);

  // Every action goes through here: POST the partial, adopt the
  // sanitized full state the server returns. Disabled-while-in-flight
  // beats optimistic guessing inside OBS — round trips are local-fast.
  const postStudio = useCallback(
    async (patch: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(studioUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
          cache: "no-store",
        });
        if (!res.ok) {
          setError(`Save failed (${res.status}) — try again.`);
          return;
        }
        setStudio(sanitizeStudioState(await res.json()));
      } catch {
        setError("Save failed — check the connection and try again.");
      } finally {
        setBusy(false);
      }
    },
    [studioUrl],
  );

  const highlightMessage = useCallback(
    (m: ChatMessage) =>
      postStudio({
        highlight: { platform: m.platform, user: m.user, text: m.text },
      }),
    [postStudio],
  );

  const blockUser = useCallback(
    (user: string) =>
      postStudio({ blockedUsers: [...studio.blockedUsers, user] }),
    [postStudio, studio.blockedUsers],
  );

  const [dockUrl, setDockUrl] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setDockUrl(window.location.href);
  }, []);
  const copyDockUrl = async () => {
    if (!navigator.clipboard || !dockUrl) return;
    await navigator.clipboard.writeText(dockUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const jumpTo = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ block: "start" });

  return (
    <div className="mx-auto min-h-screen w-full max-w-6xl p-2 font-sans text-text sm:p-3">
      {/* Narrow-mode sticky jump tabs — the OBS dock has no room for
          a permanent two-column layout. */}
      <div className="sticky top-0 z-10 -mx-2 mb-2 flex items-center gap-1 overflow-x-auto border-b border-border bg-[#0b0e14] px-2 py-1.5 lg:hidden">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => jumpTo(s.id)}
            className="whitespace-nowrap rounded-md px-2 py-1 text-caption text-text-muted hover:bg-bg-elevated hover:text-text"
          >
            {s.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="mb-2 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-caption text-danger">
          {error}
        </div>
      ) : null}

      <div className="min-w-0 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-4">
        <section id="dock-chat" className="mb-3 min-w-0 scroll-mt-12 lg:mb-0">
          <DockChat
            loaded={loaded}
            platforms={platforms}
            messages={messages}
            statuses={statuses}
            blockedUsers={studio.blockedUsers}
            busy={busy}
            onHighlight={(m) => void highlightMessage(m)}
            onBlock={(user) => void blockUser(user)}
          />
        </section>

        <div className="min-w-0 space-y-3">
          <section id="dock-highlight" className="scroll-mt-12">
            <SectionCard title="Highlight">
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
                  <DockButton
                    disabled={busy}
                    onClick={() => void postStudio({ highlight: null })}
                  >
                    Clear highlight
                  </DockButton>
                </div>
              ) : (
                <p className="text-caption text-text-dim">
                  Nothing pinned. Tap a chat message's <b>Highlight</b> to
                  pin it on stream.
                </p>
              )}
            </SectionCard>
          </section>

          <section id="dock-poll" className="scroll-mt-12">
            <SectionCard title="Poll">
              <DockPoll
                poll={studio.poll}
                messages={messages}
                busy={busy}
                onPost={postStudio}
              />
            </SectionCard>
          </section>

          <section id="dock-goals" className="scroll-mt-12">
            <SectionCard title="Goals">
              <DockGoals
                goals={studio.goals}
                busy={busy}
                onPost={postStudio}
              />
            </SectionCard>
          </section>

          <section id="dock-actions" className="scroll-mt-12">
            <SectionCard title="Actions">
              <div className="space-y-3">
                <DockButton
                  disabled={busy}
                  onClick={() => void postStudio({ recap: true })}
                >
                  Fire session recap
                </DockButton>
                <p className="text-micro text-text-dim">
                  Plays the session recap on your overlay.
                </p>
                <div className="border-t border-border pt-3">
                  <a
                    href="/settings"
                    target="_blank"
                    rel="noreferrer"
                    className="text-caption text-accent-cyan underline-offset-2 hover:underline"
                  >
                    Open Settings
                  </a>
                  <p className="mt-2 text-micro text-text-dim">
                    Add this page as an OBS custom browser dock: Docks →
                    Custom Browser Docks, paste the URL.
                  </p>
                  <button
                    type="button"
                    onClick={() => void copyDockUrl()}
                    className="mt-1.5 rounded-md border border-border bg-bg-elevated px-2.5 py-1 text-micro text-text hover:border-accent"
                  >
                    {copied ? "Copied" : "Copy dock URL"}
                  </button>
                </div>
              </div>
            </SectionCard>
          </section>
        </div>
      </div>
    </div>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-surface p-3">
      <div className="mb-2 text-micro font-bold uppercase tracking-widest text-accent-cyan">
        {title}
      </div>
      {children}
    </div>
  );
}

export function DockButton({
  disabled,
  onClick,
  danger,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        "rounded-md border px-2.5 py-1.5 text-caption font-medium transition-colors disabled:opacity-50",
        danger
          ? "border-danger/50 text-danger hover:bg-danger/10"
          : "border-border bg-bg-elevated text-text hover:border-accent",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
