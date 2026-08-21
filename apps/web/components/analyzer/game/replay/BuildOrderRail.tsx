"use client";

/**
 * BuildOrderRail — right rail. The build as it happens.
 *
 * One row per produced item, colour-coded per side:
 *
 *     [icon]  Spawning Pool        10 · 0:33
 *
 * The feed follows the playhead: the last item produced at or before
 * the scrub time is highlighted and scrolled to. Auto-scroll can be
 * paused, and honours ``prefers-reduced-motion`` (jump, don't glide).
 *
 * Data provenance: the event TIMES are real (``units[].born`` for
 * units, ``buildings[].t`` for structures). The supply number beside
 * each row is the payload's own supply-used series interpolated at that
 * time — real data, but sampled at the series' ~10 s cadence, so it can
 * be a supply or two off for something produced between two rows.
 *
 * The header's build name is either what the host passed in (the
 * game's detected build, which lives in a DIFFERENT endpoint) or a
 * plainly-labelled heuristic read of the side's first three tech
 * structures. The match percentage renders only when the host supplies
 * one — ``MapPlayback`` has no reference build to compare against.
 */

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  buildOrderIndexAt,
  formatClock,
  prettyName,
  type BuildOrderEntry,
  type ReplayHudModel,
} from "@/lib/replayHud";
import { ReplayIcon } from "./ReplayIcon";
import {
  chipClass,
  RAIL_CLASS,
  RAIL_HEADER_CLASS,
  SIDE_COLOR,
  SIDE_TINT,
  sideLabel,
} from "./replayTheme";

export type BuildFilter = "both" | "me" | "opp";

/** Rows rendered past the playhead. A live feed should not spoil the
 *  rest of the game, but ending flush at the highlight reads as a bug —
 *  and this is also what keeps the DOM bounded early on, when the
 *  derived feed for a maxed-out payload is a couple of thousand rows. */
const FEED_LOOKAHEAD_ROWS = 10;

/** True while the OS asks for reduced motion. Re-reads on change so a
 *  mid-session preference flip is honoured without a reload. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    // Older jsdom / Safari expose the query without the listener API.
    if (typeof mq.addEventListener !== "function") return;
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function BuildRow({
  entry,
  current,
  ahead,
  onSeek,
  rowRef,
}: {
  entry: BuildOrderEntry;
  current: boolean;
  /** Not produced yet at the scrub time — shown faint as a lookahead. */
  ahead: boolean;
  onSeek: (t: number) => void;
  /** Set only on the current row — the anchor auto-scroll centres. */
  rowRef?: MutableRefObject<HTMLLIElement | null>;
}) {
  const name = prettyName(entry.name);
  return (
    <li ref={rowRef}>
      <button
        type="button"
        onClick={() => onSeek(entry.t)}
        aria-current={current ? "true" : undefined}
        aria-label={`${name}${entry.count > 1 ? ` times ${entry.count}` : ""}, ${
          entry.supply
        } supply, at ${formatClock(entry.t)}. Jump here.`}
        className={`flex w-full items-center gap-2 border-l-[3px] px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-cyan ${
          current ? "" : "hover:bg-bg-subtle/70"
        }`}
        style={{
          // The side stripe is the ONLY thing that tells the two
          // players apart in this list, so it stays at full strength on
          // every row; only the CONTENT dims for the lookahead.
          borderLeftColor: SIDE_COLOR[entry.owner],
          background: current ? SIDE_TINT[entry.owner] : undefined,
        }}
      >
        <ReplayIcon
          name={entry.name}
          kind={entry.kind}
          side={entry.owner}
          /* Lookahead rows are dimmed with opacity on the CONTENT
             rather than on the row, so the icons fade with the text
             instead of the row losing its side stripe. */
          className={`h-6 w-6 ${ahead ? "opacity-45" : ""}`}
        />
        <span
          className={`min-w-0 flex-1 truncate text-micro ${
            current
              ? "font-semibold text-text"
              : ahead
                ? "text-text-dim/70"
                : "text-text-muted"
          }`}
        >
          {name}
          {entry.count > 1 ? (
            <span className={current ? "text-text-muted" : "text-text-dim"}>
              {` ×${entry.count}`}
            </span>
          ) : null}
        </span>
        <span
          className={`shrink-0 whitespace-nowrap text-micro tabular-nums ${
            current ? "font-semibold text-text" : ahead ? "text-text-dim/70" : "text-text-dim"
          }`}
        >
          {entry.supply} · {formatClock(entry.t)}
        </span>
      </button>
    </li>
  );
}

function BuildOrderRailImpl({
  model,
  t,
  filter,
  onFilterChange,
  showWorkers,
  onShowWorkersChange,
  autoScroll,
  onAutoScrollChange,
  onSeek,
  buildName,
  buildMatchPct,
  myName,
  oppName,
  className = "",
}: {
  model: ReplayHudModel;
  t: number;
  filter: BuildFilter;
  onFilterChange: (f: BuildFilter) => void;
  showWorkers: boolean;
  onShowWorkersChange: (v: boolean) => void;
  autoScroll: boolean;
  onAutoScrollChange: (v: boolean) => void;
  onSeek: (t: number) => void;
  buildName?: string | null;
  buildMatchPct?: number | null;
  myName?: string | null;
  oppName?: string | null;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const listRef = useRef<HTMLOListElement | null>(null);
  const currentRef = useRef<HTMLLIElement | null>(null);

  // The filtered feed is a pure function of (payload, filter, workers)
  // — never of the clock — so scrubbing and playing cost nothing here.
  const rows = useMemo(() => {
    return model.buildOrder.filter((e) => {
      if (filter !== "both" && e.owner !== filter) return false;
      if (!showWorkers && e.isWorker) return false;
      return true;
    });
  }, [model.buildOrder, filter, showWorkers]);

  const currentIndex = buildOrderIndexAt(rows, t);
  // Render what has happened plus a short lookahead — the feed follows
  // the playhead rather than dumping the whole game in the DOM.
  const visible = rows.slice(0, currentIndex + 1 + FEED_LOOKAHEAD_ROWS);

  // Scroll the LIST, not via ``scrollIntoView`` — that walks up and
  // would scroll the page under a full-bleed stage every 4 Hz tick.
  useEffect(() => {
    if (!autoScroll) return;
    const el = currentRef.current;
    const list = listRef.current;
    if (!el || !list || typeof list.scrollTo !== "function") return;
    const top = el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
    list.scrollTo({
      top: Math.max(0, top),
      behavior: reduced ? "auto" : "smooth",
    });
  }, [currentIndex, autoScroll, reduced]);

  const headerBuild =
    (buildName || "").trim() ||
    (filter === "opp" ? model.opening.opp : model.opening.me) ||
    null;
  const headerIsDerived = !(buildName || "").trim();

  return (
    <aside
      data-testid="replay-build-order-rail"
      aria-label="Build order"
      className={`${RAIL_CLASS} ${className}`}
    >
      <div className={`${RAIL_HEADER_CLASS} flex-wrap gap-y-1`}>
        <span className="min-w-0 flex-1 truncate text-caption font-semibold tracking-tight text-text">
          Build order
        </span>
        {typeof buildMatchPct === "number" ? (
          <span
            className="shrink-0 rounded-md border border-accent-cyan/40 bg-accent-cyan/10 px-1.5 py-0.5 text-micro font-semibold tabular-nums text-text"
            title="How closely this game matched the reference build"
          >
            {Math.round(buildMatchPct)}% match
          </span>
        ) : null}
        {headerBuild ? (
          <p
            className="w-full truncate text-micro font-medium text-text-dim"
            title={
              headerIsDerived
                ? `Read from the first structures placed — ${headerBuild}`
                : headerBuild
            }
          >
            {headerIsDerived ? "Opening: " : ""}
            {headerBuild}
          </p>
        ) : null}
      </div>

      {/* Two fixed rows rather than one wrapping row: with real player
          names in the side filter the single row wrapped unpredictably
          and dropped "Following" onto a line of its own. */}
      <div className="shrink-0 space-y-1 border-b border-border p-2">
        <div
          role="group"
          aria-label="Filter build order by side"
          className="flex gap-1"
        >
          {([
            ["both", "Both"],
            ["me", sideLabel("me", myName)],
            ["opp", sideLabel("opp", null, oppName)],
          ] as const).map(([id, text]) => (
            <button
              key={id}
              type="button"
              onClick={() => onFilterChange(id)}
              aria-pressed={filter === id}
              title={id === "both" ? "Show both players" : `Show ${text} only`}
              className={`min-w-0 flex-1 truncate ${chipClass(filter === id)}`}
            >
              {text}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onShowWorkersChange(!showWorkers)}
            aria-pressed={showWorkers}
            aria-label="Show worker production in the build order"
            title="Show worker production"
            className={`flex-1 ${chipClass(showWorkers)}`}
          >
            Workers
          </button>
          <button
            type="button"
            onClick={() => onAutoScrollChange(!autoScroll)}
            aria-pressed={autoScroll}
            aria-label="Follow the playhead automatically"
            title="Auto-scroll with playback"
            className={`flex-1 ${chipClass(autoScroll)}`}
          >
            {autoScroll ? "Following" : "Paused"}
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="px-3 py-3 text-caption text-text-dim">
          Nothing to show with these filters.
        </p>
      ) : (
        <ol
          ref={listRef}
          className="replay-scroll relative min-h-0 flex-1 overflow-y-auto py-1"
          aria-label="Build order feed"
        >
          {visible.map((entry, i) => (
            <BuildRow
              key={entry.key}
              entry={entry}
              current={i === currentIndex}
              ahead={i > currentIndex}
              onSeek={onSeek}
              rowRef={i === currentIndex ? currentRef : undefined}
            />
          ))}
        </ol>
      )}
    </aside>
  );
}

export const BuildOrderRail = memo(BuildOrderRailImpl);
