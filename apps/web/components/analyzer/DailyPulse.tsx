"use client";

/**
 * Daily Pulse — the dashboard's fresh-content strip. Renders the day's
 * rotation of insight cards from lib/dailyPulse.ts: yesterday's
 * session, live streaks, MMR peak-chasing, rising builds, nemesis
 * sightings, map edges, matchup shifts, milestones, throwbacks and
 * macro trends — all derived from the user's real replay corpus, never
 * synthesised.
 *
 * Freshness mechanics:
 *   - useDailySeed re-keys on day rollover (checked once a minute), so
 *     the strip rotates to the new day's mix without a refresh.
 *   - One analyzer-scoped provider owns the memory-bounded corpus, so the
 *     dashboard strip and Arcade reuse the same current flat snapshot.
 *   - Cards deep-link into the analyzer tab that owns the full story
 *     (via onNavigate — tab state lives in DashboardLayout, not URLs).
 *
 * If the corpus can't support a card yet, the strip keeps a compact empty
 * state so the loaded corpus can still be collapsed and released.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, ChevronDown, Loader2 } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { selectDailyPulse, type PulseCard, type PulseTone } from "@/lib/dailyPulse";
import {
  normaliseGame,
} from "@/components/analyzer/arcade/hooks/useArcadeData";
import { useAnalysisGames } from "@/components/analyzer/arcade/hooks/useAnalysisGames";
import { useDailySeed } from "@/components/analyzer/arcade/hooks/useDailySeed";
import type { TabId } from "@/components/analyzer/tabs";

interface ApiSeasons {
  mapPool?: string[];
  /** Emergency baked fallback is useful for games, but not current-veto advice. */
  mapPoolSource?: "liquipedia" | "persisted" | "fallback";
  mapPoolFetchedAt?: number | null;
}

const LS_COLLAPSED_KEY = "analyzer.pulse.collapsed";
const CURRENT_POOL_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

type PulseIntent = "hydrating" | "dormant" | "open" | "closed";

function readPulseIntent(): Exclude<PulseIntent, "hydrating"> {
  if (typeof window === "undefined") return "dormant";
  try {
    const stored = window.localStorage.getItem(LS_COLLAPSED_KEY);
    if (stored === "0") return "open";
    if (stored === "1") return "closed";
    return "dormant";
  } catch {
    return "dormant";
  }
}

function writeCollapsed(v: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_COLLAPSED_KEY, v ? "1" : "0");
  } catch {
    /* non-fatal */
  }
}

/**
 * Tone → visual accents. Left border carries the tone; the stat picks
 * up the matching text colour so the strip scans at a glance.
 */
const TONE_CLASSES: Record<
  PulseTone,
  { border: string; stat: string; kicker: string }
> = {
  positive: {
    border: "border-l-success",
    stat: "text-success",
    kicker: "text-success",
  },
  warning: {
    border: "border-l-warning",
    stat: "text-warning",
    kicker: "text-warning",
  },
  neutral: {
    border: "border-l-line",
    stat: "text-text",
    kicker: "text-text-dim",
  },
  accent: {
    border: "border-l-accent",
    stat: "text-accent",
    kicker: "text-accent",
  },
};

export function DailyPulse({
  onNavigate,
  onOpenOpponent,
}: {
  onNavigate?: (tab: TabId) => void;
  /** Opens one opponent dossier directly (nemesis / rival cards). */
  onOpenOpponent?: (pulseId: string) => void;
}) {
  const seed = useDailySeed();

  // Shared with Arcade, but deliberately dormant on an ordinary dashboard.
  // The compact gate below activates it only after the user asks to see the
  // pulse; opening Arcade activates the same provider automatically.
  const gamesRes = useAnalysisGames();
  const gamesActive = gamesRes.isActive;
  const loadGames = gamesRes.load;
  const seasonsRes = useApi<ApiSeasons>("/v1/seasons");

  const games = useMemo(
    () =>
      Array.isArray(gamesRes.items)
        ? gamesRes.items.map(normaliseGame)
        : [],
    [gamesRes.items],
  );
  const mapPool = useMemo(
    () => {
      const source = seasonsRes.data?.mapPoolSource;
      if (source === "fallback") return [];
      if (source === "persisted") {
        const fetchedAt = seasonsRes.data?.mapPoolFetchedAt;
        if (
          typeof fetchedAt !== "number" ||
          !Number.isFinite(fetchedAt) ||
          Date.now() - fetchedAt > CURRENT_POOL_MAX_AGE_MS
        ) {
          return [];
        }
      } else if (source !== "liquipedia") {
        return [];
      }
      return Array.isArray(seasonsRes.data?.mapPool)
        ? seasonsRes.data!.mapPool
        : [];
    },
    [seasonsRes.data],
  );

  const selection = useMemo(
    () =>
      selectDailyPulse(seed.day, games, {
        userId: seed.userId,
        tz: seed.tz,
        mapPool,
      }),
    [seed.day, seed.userId, seed.tz, games, mapPool],
  );

  // The absence of a stored choice keeps the expensive corpus dormant. Once
  // the user opens Daily Pulse, the legacy raw "0" value records that intent;
  // raw "1" records an explicit close. Keeping those values avoids resetting
  // the preference for existing users.
  const [intent, setIntent] = useState<PulseIntent>("hydrating");
  useEffect(() => {
    setIntent(readPulseIntent());
  }, []);

  // Provider activation is intentionally memory-only, so restore a persisted
  // open choice after every mount. `load` changes identity when Clerk finishes
  // resolving the account, which also lets an early no-op retry safely then.
  useEffect(() => {
    if (intent === "open" && !gamesActive) loadGames();
  }, [gamesActive, intent, loadGames]);

  const collapsed = intent === "closed";
  const toggle = () => {
    const next = !collapsed;
    setIntent(next ? "closed" : "open");
    writeCollapsed(next);
    if (next) gamesRes.release();
  };

  const loadPulse = () => {
    const retryingOpenRequest = intent === "open";
    setIntent("open");
    writeCollapsed(false);
    // A dormant/closed -> open transition is handled once by the restore
    // effect. An already-open error gate needs an explicit retry because its
    // intent value does not change.
    if (retryingOpenRequest || gamesRes.error) gamesRes.load();
  };

  if (intent === "hydrating") {
    return <DailyPulseFrame pending />;
  }

  if (collapsed) {
    return <DailyPulseFrame collapsed onToggle={toggle} />;
  }

  // A missing preference remains an inexpensive opt-in gate. A stored open
  // preference instead renders the expanded shell immediately and restores
  // the live corpus behind an honest loading state.
  if (!gamesRes.isActive && intent !== "open") {
    return <DailyPulseGate onLoad={loadPulse} />;
  }

  return (
    <DailyPulseFrame collapsed={false} onToggle={toggle}>
      {!gamesRes.isActive || gamesRes.isLoading ? (
        <DailyPulseStatus />
      ) : gamesRes.error ? (
        <DailyPulseStatus failed onRetry={loadPulse} />
      ) : selection.cards.length > 0 ? (
        <div className="flex snap-x gap-3 overflow-x-auto pb-1">
          {selection.cards.map((card) => (
            <PulseCardView
              key={card.id}
              card={card}
              onNavigate={onNavigate}
              onOpenOpponent={onOpenOpponent}
            />
          ))}
        </div>
      ) : (
        <p className="px-1 py-1 text-xs text-text-dim">
          No replay insights yet. More games will unlock your daily pulse.
        </p>
      )}
    </DailyPulseFrame>
  );
}

function DailyPulseFrame({
  collapsed = false,
  onToggle,
  children,
  pending = false,
}: {
  collapsed?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
  pending?: boolean;
}) {
  const headerContent = (
    <>
      <span className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden className="relative flex h-2 w-2 flex-shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        <span className="text-caption font-semibold text-text">
          Daily Pulse
        </span>
        <span className="hidden truncate text-micro text-text-dim sm:inline">
          fresh from your replays · rotates daily
        </span>
      </span>
      {!pending ? (
        <ChevronDown
          aria-hidden
          className={`h-4 w-4 flex-shrink-0 text-text-dim transition-transform ${
            collapsed ? "-rotate-90" : ""
          }`}
        />
      ) : null}
    </>
  );
  return (
    <section
      aria-label="Daily Pulse"
      className="overflow-hidden rounded-xl border-2 border-line bg-bg-surface shadow-hard"
    >
      {pending ? (
        <div className="flex min-h-[48px] w-full items-center justify-between gap-3 px-4 py-3">
          {headerContent}
        </div>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          aria-controls="daily-pulse-content"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Open" : "Close"} Daily Pulse`}
          className="flex min-h-[48px] w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
          {headerContent}
        </button>
      )}
      {!pending ? (
        <div
          id="daily-pulse-content"
          hidden={collapsed}
          className="border-t border-border p-3"
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

function DailyPulseGate({ onLoad }: { onLoad: () => void }) {
  return (
    <section
      aria-label="Daily Pulse"
      className="overflow-hidden rounded-xl border-2 border-line bg-bg-surface shadow-hard"
    >
      <button
        type="button"
        onClick={onLoad}
        aria-expanded={false}
        className="flex min-h-[48px] w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className="relative flex h-2 w-2 flex-shrink-0">
            <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
          <span className="text-caption font-semibold text-text">
            Daily Pulse
          </span>
          <span className="truncate text-micro text-text-dim">
            Replay insights, loaded when you open them
          </span>
        </span>
        <span className="inline-flex flex-shrink-0 items-center gap-1 text-micro font-semibold text-accent">
          Load
          <ArrowRight aria-hidden className="h-3 w-3" />
        </span>
      </button>
    </section>
  );
}

function DailyPulseStatus({
  failed = false,
  onRetry,
}: {
  failed?: boolean;
  onRetry?: () => void;
}) {
  if (failed) {
    return (
      <div className="flex min-h-[44px] flex-wrap items-center justify-between gap-3 px-1 py-1">
        <span className="text-xs text-text-dim">
          Replay insights couldn’t load
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-[36px] items-center justify-center rounded-full border border-line bg-bg-surface px-3 text-micro font-semibold text-accent transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Try again
        </button>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="flex min-h-[44px] items-center gap-2 px-1 py-1 text-xs text-text-dim"
    >
      <Loader2 aria-hidden className="h-4 w-4 animate-spin text-accent" />
      Loading replay insights…
    </div>
  );
}

function PulseCardView({
  card,
  onNavigate,
  onOpenOpponent,
}: {
  card: PulseCard;
  onNavigate?: (tab: TabId) => void;
  onOpenOpponent?: (pulseId: string) => void;
}) {
  const tone = TONE_CLASSES[card.tone];
  // Opponent cards deep-link into the player's dossier; every other
  // card lands on the analyzer tab that owns the full story.
  const openOpponent =
    card.targetOpponentId && onOpenOpponent
      ? () => onOpenOpponent(card.targetOpponentId!)
      : null;
  const openTab =
    card.targetTab && onNavigate
      ? () => onNavigate(card.targetTab as TabId)
      : null;
  const onOpen = openOpponent ?? openTab;
  const clickable = onOpen !== null;
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div
            className={`text-micro font-semibold uppercase tracking-wider ${tone.kicker}`}
          >
            {card.kicker}
          </div>
          <div className="mt-1 text-sm font-semibold leading-snug text-text">
            {card.title}
          </div>
        </div>
        {card.stat ? (
          <div className="flex-shrink-0 text-right">
            <div
              className={`text-lg font-bold tabular-nums leading-none ${tone.stat}`}
            >
              {card.stat}
            </div>
            {card.statLabel ? (
              <div className="mt-1 text-micro text-text-dim">
                {card.statLabel}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-text-dim">{card.body}</p>
      {clickable ? (
        <span className="mt-2 inline-flex items-center gap-1 text-micro font-semibold text-accent">
          Open <ArrowRight aria-hidden className="h-3 w-3" />
        </span>
      ) : null}
    </>
  );

  const baseClass = `w-[280px] flex-shrink-0 snap-start rounded-lg border border-border border-l-4 ${tone.border} bg-bg-elevated/60 px-3.5 py-3 sm:w-[300px]`;

  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={`${baseClass} text-left transition-colors hover:border-accent hover:bg-bg-elevated`}
      >
        {body}
      </button>
    );
  }
  return <article className={baseClass}>{body}</article>;
}
