"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { ReplayMapMarker } from "@/lib/replayMarkers";
import type { CommentTimelineMarker } from "@/components/analyzer/game/replay/TransportDock";
import { formatGameClock } from "@/lib/notes";
import { useGameNotes } from "./useGameNotes";

/** One "write a note here" request: a moment, an optional map point and a sequence. */
export type GameNoteDraftRequest = { t: number | null; point: { x: number; y: number } | null; seq: number };

/**
 * Shared state between the game page's notes list and its replay player:
 * the transport dock's "Add note at 4:12" (B) opens the composer at that
 * moment, "Pin on map" turns the next map click into the note's point, and
 * saved notes come back as timeline markers and map pins.
 */
export function useGameNoteWorkspace(gameId: string, seek: (t: number) => void) {
  const notes = useGameNotes(gameId);
  const [draft, setDraft] = useState<GameNoteDraftRequest | null>(null);
  const [picking, setPicking] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const seq = useRef(0);

  const startNote = useCallback((t: number | null) => {
    seq.current += 1;
    setDraft({ t: typeof t === "number" && Number.isFinite(t) ? Math.max(0, Math.round(t * 10) / 10) : null, point: null, seq: seq.current });
  }, []);
  const cancelNote = useCallback(() => { setDraft(null); setPicking(false); }, []);

  const onWorldClick = useCallback((x: number, y: number, t: number) => {
    setDraft((previous) => {
      if (previous) return { ...previous, t: previous.t ?? Math.round(t * 10) / 10, point: { x, y } };
      seq.current += 1;
      return { t: Math.round(t * 10) / 10, point: { x, y }, seq: seq.current };
    });
    setPicking(false);
  }, []);

  const focusNote = useCallback((id: string) => {
    setActiveId(id);
    document.getElementById(`game-note-${id}`)?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const mapMarkers = useMemo<ReplayMapMarker[]>(() => {
    const out: ReplayMapMarker[] = [];
    notes.items.forEach((note, index) => {
      if (typeof note.x !== "number" || typeof note.y !== "number" || typeof note.gameTimeSec !== "number") return;
      out.push({ id: note.id, x: note.x, y: note.y, t: note.gameTimeSec, label: String(index + 1), active: note.id === activeId });
    });
    if (draft?.point) out.push({ id: "__draft__:note", x: draft.point.x, y: draft.point.y, t: draft.t ?? 0, label: "+", draft: true });
    return out;
  }, [notes.items, activeId, draft]);

  const commentMarkers = useMemo<CommentTimelineMarker[]>(() => notes.items
    .filter((note) => typeof note.gameTimeSec === "number")
    .map((note) => ({ id: note.id, t: note.gameTimeSec as number, count: 1, label: `Note at ${formatGameClock(note.gameTimeSec as number)}` })), [notes.items]);

  const onCommentMarker = useCallback((marker: CommentTimelineMarker) => { seek(marker.t); focusNote(marker.id); }, [seek, focusNote]);
  const onMarkerClick = useCallback((id: string) => {
    if (id.startsWith("__draft__")) return;
    const note = notes.items.find((row) => row.id === id);
    if (typeof note?.gameTimeSec === "number") seek(note.gameTimeSec);
    focusNote(id);
  }, [notes.items, seek, focusNote]);

  return {
    notes, draft, setDraft, startNote, cancelNote, picking, setPicking, activeId, setActiveId,
    mapMarkers, commentMarkers, onWorldClick: picking ? onWorldClick : undefined, onMarkerClick, onCommentMarker,
  };
}

export type GameNoteWorkspace = ReturnType<typeof useGameNoteWorkspace>;
