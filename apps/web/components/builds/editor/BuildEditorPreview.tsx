"use client";

import { ChevronDown, ChevronRight, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { formatTime, PREVIEW_PAGE_SIZE } from "@/lib/build-rules";
import type { BuildOrderEvent } from "@/lib/build-events";
import type {
  BuildEditorPreviewAlmost,
  BuildEditorPreviewMatch,
  BuildEditorPreviewProps,
  BuildEditorPreviewResult,
} from "./BuildEditor.types";
import type { BuildRule } from "@/lib/build-rules";

/**
 * BuildEditorPreview — Section 3 of the BuildEditor.
 *
 * Reads the `preview` result from the editor state hook, renders:
 *   - A status banner ("Scoring against your games…", "✓ N of your M
 *     games match all R rules (P%).", or error message).
 *   - Optionally a "Hidden N · show all" link when the user has
 *     dismissed false-positive matches.
 *   - The matches list (paginated, 5/page).
 *   - The almost-matches list (one rule failed, with the failure
 *     reason inline).
 *
 * Each row supports inline inspect — clicking expands the row to show
 * the underlying parsed events from /v1/games/:id/build-order. Events
 * matching one of the user's rule names are accent-highlighted so the
 * user can spot which event triggered the hit.
 */
export function BuildEditorPreview({
  preview,
  loading,
  error,
  rules,
  expandedMatchId,
  toggleInspect,
  hiddenMatchIds,
  hideMatch,
  unhideAll,
  inspectCache,
  inspectLoading,
  previewPage,
  almostPage,
  setPreviewPage,
  setAlmostPage,
}: BuildEditorPreviewProps) {
  const empty: BuildEditorPreviewResult = {
    matches: [],
    almost_matches: [],
    scanned_games: 0,
    truncated: false,
  };
  const pr = preview || empty;
  const matches = pr.matches.filter((m) => !hiddenMatchIds.has(m.game_id));
  const almost = pr.almost_matches.filter(
    (m) => !hiddenMatchIds.has(m.game_id),
  );
  const hiddenCount =
    pr.matches.length -
    matches.length +
    (pr.almost_matches.length - almost.length);

  const banner = computeBannerText({
    rules,
    preview: pr,
    loading,
    error,
    matchesCount: matches.length,
  });

  return (
    <section aria-label="Match preview" className="space-y-2">
      <h3 className="text-caption font-semibold uppercase tracking-wider text-text-muted">
        3 · Match preview
      </h3>
      <p
        className="text-body text-text"
        aria-live="polite"
      >
        {banner}
      </p>
      {hiddenCount > 0 ? (
        <p className="text-caption text-text-dim">
          {hiddenCount} hidden ·{" "}
          <button
            type="button"
            onClick={unhideAll}
            className="underline hover:text-text"
          >
            show all
          </button>
        </p>
      ) : null}

      {matches.length > 0 ? (
        <PreviewList
          label="Matches"
          items={matches}
          page={previewPage}
          setPage={setPreviewPage}
          ruleCount={rules.length}
          isAlmost={false}
          rules={rules}
          expandedMatchId={expandedMatchId}
          toggleInspect={toggleInspect}
          hideMatch={hideMatch}
          inspectCache={inspectCache}
          inspectLoading={inspectLoading}
        />
      ) : null}

      {almost.length > 0 ? (
        <PreviewList
          label="Almost matches — failed exactly 1 rule (click ▶ to inspect)"
          items={almost}
          page={almostPage}
          setPage={setAlmostPage}
          ruleCount={0}
          isAlmost
          rules={rules}
          expandedMatchId={expandedMatchId}
          toggleInspect={toggleInspect}
          hideMatch={hideMatch}
          inspectCache={inspectCache}
          inspectLoading={inspectLoading}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Banner text                                                        */
/* ------------------------------------------------------------------ */

function computeBannerText(args: {
  rules: ReadonlyArray<BuildRule>;
  preview: BuildEditorPreviewResult;
  loading: boolean;
  error: string | null;
  matchesCount: number;
}): string {
  const { rules, preview, loading, error, matchesCount } = args;
  if (loading) return "Scoring against your games…";
  if (error) return `Preview error: ${error}`;
  if (rules.length === 0) return "Add a rule to see matches.";
  const total = preview.matches.length;
  const pct =
    preview.scanned_games > 0
      ? ((total / preview.scanned_games) * 100).toFixed(1)
      : "0.0";
  return `✓ ${matchesCount}${preview.truncated ? "+" : ""} of your ${preview.scanned_games} games match all ${rules.length} rules (${pct}%).`;
}

/* ------------------------------------------------------------------ */
/* Paginated list                                                     */
/* ------------------------------------------------------------------ */

interface PreviewListProps {
  label: string;
  items: ReadonlyArray<BuildEditorPreviewMatch | BuildEditorPreviewAlmost>;
  page: number;
  setPage: (next: number | ((cur: number) => number)) => void;
  ruleCount: number;
  isAlmost: boolean;
  rules: ReadonlyArray<BuildRule>;
  expandedMatchId: string | null;
  toggleInspect: (gameId: string) => void;
  hideMatch: (gameId: string) => void;
  inspectCache: Readonly<Record<string, ReadonlyArray<BuildOrderEvent>>>;
  inspectLoading: Readonly<Record<string, boolean>>;
}

function PreviewList({
  label,
  items,
  page,
  setPage,
  ruleCount,
  isAlmost,
  rules,
  expandedMatchId,
  toggleInspect,
  hideMatch,
  inspectCache,
  inspectLoading,
}: PreviewListProps) {
  const totalPages = Math.max(1, Math.ceil(items.length / PREVIEW_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const start = p * PREVIEW_PAGE_SIZE;
  const pageItems = items.slice(start, start + PREVIEW_PAGE_SIZE);
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <ul
        role="list"
        className="overflow-hidden rounded-lg border border-border bg-bg-subtle/50 divide-y divide-border"
      >
        {pageItems.map((m, i) => (
          <PreviewRow
            key={`${m.game_id}-${start + i}`}
            row={m}
            indexLabel={start + i + 1}
            ruleCount={ruleCount}
            isAlmost={isAlmost}
            rules={rules}
            expanded={!!m.game_id && expandedMatchId === m.game_id}
            toggleInspect={toggleInspect}
            hideMatch={hideMatch}
            events={m.game_id ? inspectCache[m.game_id] : undefined}
            loading={!!(m.game_id && inspectLoading[m.game_id])}
          />
        ))}
      </ul>
      {items.length > PREVIEW_PAGE_SIZE ? (
        <Pager
          page={p}
          totalPages={totalPages}
          total={items.length}
          setPage={setPage}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PreviewRow                                                         */
/* ------------------------------------------------------------------ */

interface PreviewRowProps {
  row: BuildEditorPreviewMatch | BuildEditorPreviewAlmost;
  indexLabel: number;
  ruleCount: number;
  isAlmost: boolean;
  rules: ReadonlyArray<BuildRule>;
  expanded: boolean;
  toggleInspect: (gameId: string) => void;
  hideMatch: (gameId: string) => void;
  events?: ReadonlyArray<BuildOrderEvent>;
  loading: boolean;
}

function PreviewRow({
  row,
  indexLabel,
  ruleCount,
  isAlmost,
  rules,
  expanded,
  toggleInspect,
  hideMatch,
  events,
  loading,
}: PreviewRowProps) {
  const canInspect = !!row.game_id;
  return (
    <>
      <li
        className={[
          "flex items-center gap-2 px-3 py-1.5 text-caption",
          canInspect ? "cursor-pointer hover:bg-bg-elevated/50" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={
          canInspect
            ? expanded
              ? "Click to hide events"
              : "Click to inspect this game's events"
            : undefined
        }
        onClick={(e) => {
          if (!canInspect) return;
          if ((e.target as HTMLElement).closest("[data-row-action]")) return;
          toggleInspect(row.game_id);
        }}
      >
        <span className="w-8 text-right font-mono tabular-nums text-text-dim">
          #{indexLabel}
        </span>
        {canInspect ? (
          <span
            className={[
              "inline-flex h-5 w-5 items-center justify-center rounded text-accent-cyan",
              expanded ? "bg-accent-cyan/15" : "",
            ].join(" ")}
            aria-hidden
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </span>
        ) : (
          <span className="w-5" />
        )}
        <span
          className={[
            "flex-1 truncate",
            canInspect ? "text-accent-cyan" : "text-text",
          ].join(" ")}
        >
          {row.build_name}
        </span>
        <span className="hidden max-w-[140px] truncate font-mono text-[10px] tabular-nums text-text-dim sm:inline">
          {row.game_id || "—"}
        </span>
        {isAlmost ? (
          <span className="max-w-[200px] truncate text-danger">
            ✗ {(row as BuildEditorPreviewAlmost).failed_reason}
          </span>
        ) : (
          <Badge variant="success" size="sm">
            ✓ {ruleCount}/{ruleCount}
          </Badge>
        )}
        {canInspect ? (
          <button
            type="button"
            data-row-action="hide"
            aria-label={`Hide ${row.build_name}`}
            title="Hide from list (does not change rules)"
            onClick={(e) => {
              e.stopPropagation();
              hideMatch(row.game_id);
            }}
            className="px-1 text-text-dim hover:text-danger"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        ) : null}
      </li>
      {expanded ? (
        <li className="border-t border-border bg-bg-elevated/40 px-6 py-2 text-[11px]">
          {loading ? (
            <p className="text-text-dim">Loading game events…</p>
          ) : !events ? (
            <p className="text-text-dim">No events available.</p>
          ) : (
            <InspectEvents events={events} rules={rules} />
          )}
        </li>
      ) : null}
    </>
  );
}

function InspectEvents({
  events,
  rules,
}: {
  events: ReadonlyArray<BuildOrderEvent>;
  rules: ReadonlyArray<BuildRule>;
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] text-text-dim">
        All {events.length} events from this game (scroll to see more):
      </p>
      <div className="grid max-h-[320px] gap-x-3 gap-y-0.5 overflow-y-auto pr-1 sm:grid-cols-2 md:grid-cols-3">
        {events.map((e, j) => {
          const matched = rules.some(
            (r) =>
              r &&
              r.name &&
              (e.name === r.name || `Build${e.name}` === r.name),
          );
          return (
            <div
              key={`${e.time}-${j}`}
              className={[
                "flex items-center gap-2 rounded px-1",
                matched ? "bg-accent-cyan/15" : "",
              ].join(" ")}
            >
              <span className="w-10 font-mono tabular-nums text-[10px] text-text-dim">
                {e.time_display || formatTime(e.time)}
              </span>
              <span
                className={[
                  "truncate",
                  matched ? "font-medium text-accent-cyan" : "text-text",
                ].join(" ")}
              >
                {e.display || e.name}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pager                                                              */
/* ------------------------------------------------------------------ */

function Pager({
  page,
  totalPages,
  total,
  setPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  setPage: (next: number | ((cur: number) => number)) => void;
}) {
  const atFirst = page <= 0;
  const atLast = page >= totalPages - 1;
  return (
    <div className="flex items-center justify-center gap-3 text-caption text-text-muted">
      <button
        type="button"
        onClick={() => setPage((p) => Math.max(0, p - 1))}
        disabled={atFirst}
        aria-label="Previous page"
        className="min-w-[44px] rounded-md bg-bg-subtle px-2 py-1 text-caption text-text hover:bg-bg-elevated disabled:cursor-not-allowed disabled:opacity-40"
      >
        ← prev
      </button>
      <span className="select-none tabular-nums">
        page {page + 1} / {totalPages} · {total} total
      </span>
      <button
        type="button"
        onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
        disabled={atLast}
        aria-label="Next page"
        className="min-w-[44px] rounded-md bg-bg-subtle px-2 py-1 text-caption text-text hover:bg-bg-elevated disabled:cursor-not-allowed disabled:opacity-40"
      >
        next →
      </button>
    </div>
  );
}
