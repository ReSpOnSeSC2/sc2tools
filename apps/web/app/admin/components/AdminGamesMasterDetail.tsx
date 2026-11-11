"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { fmtDate, fmtDuration, type AdminGameDetailGame } from "./AdminGameDetail";
import { ResultBadge } from "./ResultBadge";
import { RESULT_SPOKEN, resultOf } from "./adminResult";

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog']";
const narrowLayout = () => window.matchMedia?.("(max-width: 1023px)").matches ?? false;

/** "Game 3 of 25: Victory on Alcyone". */
export function selectionText(game: AdminGameDetailGame, at: number, total: number): string {
  return `Game ${at + 1} of ${total}: ${RESULT_SPOKEN[resultOf(game.result)]} on ${game.map || "an unknown map"}`;
}

/**
 * The shared games master/detail of the opponent and global-player pages:
 * the game list (current page), its pagination and filter slot on the left,
 * the selected game's detail on the right. On phones only one side shows at
 * a time; the detail carries its own Back control.
 *
 * Keyboard: j or ↓ selects the next game, k or ↑ the previous one, and Enter
 * on a game opens it and moves focus to the detail pane. Arrows act only
 * while focus is in the list; j and k also work from anywhere outside the
 * detail pane. Every shortcut is ignored while focus is in an input,
 * textarea, select or dialog, and with a modifier key. Each selection is
 * announced politely ("Game 3 of 25: Victory on Alcyone").
 */
export function AdminGamesMasterDetail<G extends AdminGameDetailGame>({
  games, gameKey, selectedKey, onSelect, rowMeta, filters, pagination, status, busy = false,
  detail, placeholder, label,
}: {
  games: G[];
  gameKey: (game: G) => string;
  /** The selected game's key, or null; it may name a game on another page. */
  selectedKey: string | null;
  onSelect: (game: G) => void;
  /** Extra lines under a row (the global page's owner and strategy). */
  rowMeta?: (game: G) => ReactNode;
  filters?: ReactNode;
  pagination: ReactNode;
  status: ReactNode;
  busy?: boolean;
  /** The selected game's detail; null shows ``placeholder``. */
  detail: ReactNode | null;
  placeholder: string;
  /** The list's accessible name. */
  label: string;
}) {
  const list = useRef<HTMLUListElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const focusDetail = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const index = selectedKey === null ? -1 : games.findIndex((game) => gameKey(game) === selectedKey);
  const latest = useRef({ games, index, gameKey, onSelect });
  latest.current = { games, index, gameKey, onSelect };

  // A game opened with Enter takes focus once its detail pane is showing.
  useEffect(() => {
    if (!focusDetail.current || !selectedKey) return;
    focusDetail.current = false;
    pane.current?.focus();
  }, [selectedKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(EDITABLE) || (target && pane.current?.contains(target))) return;
      const inList = !!target && !!list.current?.contains(target);
      const { games: rows, index: at, gameKey: keyOf, onSelect: select } = latest.current;
      if (event.key === "Enter") {
        const row = inList ? rows.find((game) => keyOf(game) === target?.closest("[data-game-key]")?.getAttribute("data-game-key")) : undefined;
        if (!row) return;
        event.preventDefault();
        if (rows.indexOf(row) === at) { pane.current?.focus(); return; }
        focusDetail.current = true;
        select(row);
        setAnnouncement(selectionText(row, rows.indexOf(row), rows.length));
        return;
      }
      const step = event.key === "j" || (event.key === "ArrowDown" && inList) ? 1
        : event.key === "k" || (event.key === "ArrowUp" && inList) ? -1 : 0;
      if (!step || rows.length === 0) return;
      // In the list, move from the focused row; elsewhere from the selection.
      const focused = inList ? Number(target?.closest("[data-game-index]")?.getAttribute("data-game-index")) : NaN;
      const from = Number.isInteger(focused) ? focused : at;
      const next = from < 0 ? (step > 0 ? 0 : rows.length - 1) : from + step;
      if (next < 0 || next >= rows.length) return;
      event.preventDefault();
      const focusPane = narrowLayout();
      focusDetail.current = focusPane;
      select(rows[next]);
      setAnnouncement(selectionText(rows[next], next, rows.length));
      if (!focusPane) {
        const button = list.current?.querySelector<HTMLButtonElement>(`[data-game-index="${next}"]`);
        if (inList) button?.focus();
        else button?.scrollIntoView?.({ block: "nearest" });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:gap-4">
      <p aria-live="polite" className="sr-only">{announcement}</p>
      <div className={selectedKey ? "hidden lg:block" : "block"}>
        {filters ? <div className="mb-3">{filters}</div> : null}
        <Card padded={false}>
          <p role="status" className="px-4 pt-3 text-caption text-text-muted">{status}</p>
          <p className="sr-only">Press j or the down arrow for the next game, k or the up arrow for the previous one, and Enter to open a game&apos;s details.</p>
          <ul ref={list} aria-label={label} aria-busy={busy} className={`divide-y divide-border motion-safe:transition-opacity ${busy ? "opacity-60" : ""}`}>
            {games.map((game, at) => {
              const key = gameKey(game);
              const active = key === selectedKey;
              return (
                <li key={key}>
                  <button
                    type="button"
                    data-game-key={key}
                    data-game-index={at}
                    aria-current={active ? "true" : undefined}
                    onClick={() => {
                      focusDetail.current = narrowLayout();
                      onSelect(game);
                      setAnnouncement(selectionText(game, at, games.length));
                    }}
                    className={[
                      "flex min-h-11 w-full flex-col gap-1 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent motion-safe:transition-colors",
                      active ? "bg-accent/10" : "hover:bg-bg-elevated/40",
                    ].join(" ")}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <ResultBadge result={game.result} />
                      <span className="text-caption text-text-dim">{fmtDate(game.date)}</span>
                    </span>
                    <span className="text-caption text-text-muted">
                      {(game.myRace || "?")[0]}v{(game.opponent.race || "?")[0]}
                      {" · "}
                      {game.map || "—"}
                      {" · "}
                      {fmtDuration(game.durationSec)}
                    </span>
                    {rowMeta ? rowMeta(game) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
        {pagination}
      </div>
      <div ref={pane} tabIndex={-1} role="region" aria-label="Selected game"
        className={`${selectedKey ? "block" : "hidden lg:block"} rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}>
        {detail ?? <Card padded><p className="text-text-muted">{placeholder}</p></Card>}
      </div>
    </div>
  );
}
