"use client";

import { useCallback, useMemo } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { gameNotePath, gameNotesPath, GAME_NOTES_MAX, type GameNoteInput, type GameNotesResponse, type NoteDto } from "@/lib/notes";

/** Earliest moment first; untimed notes last, then by creation. */
export function sortGameNotes(items: readonly NoteDto[]): NoteDto[] {
  return [...items].sort((a, b) => (a.gameTimeSec ?? Infinity) - (b.gameTimeSec ?? Infinity) || a.createdAt.localeCompare(b.createdAt));
}

/**
 * The owner's private notes on one game, with optimistic-free writes: each
 * call resolves with the server's note and updates the shared SWR entry, so
 * the notes list, the timeline markers and the map pins stay in step.
 */
export function useGameNotes(gameId: string | null) {
  const { getToken } = useAuth();
  const path = gameId ? gameNotesPath(gameId) : null;
  const req = useApi<GameNotesResponse>(path, { revalidateOnFocus: false, shouldRetryOnError: false });
  const { mutate } = req;
  const items = useMemo(() => sortGameNotes(req.data?.items ?? []), [req.data?.items]);
  const replace = useCallback((change: (items: NoteDto[]) => NoteDto[]) => mutate(
    (current) => ({ limit: current?.limit ?? GAME_NOTES_MAX, items: sortGameNotes(change(current?.items ?? [])) }),
    { revalidate: false },
  ), [mutate]);

  const create = useCallback(async (input: GameNoteInput) => {
    if (!gameId) throw new Error("No game");
    const note = await apiCall<NoteDto>(getToken, gameNotesPath(gameId), { method: "POST", body: JSON.stringify(input) });
    await replace((list) => [...list.filter((row) => row.id !== note.id), note]);
    return note;
  }, [gameId, getToken, replace]);

  const update = useCallback(async (noteId: string, patch: Partial<GameNoteInput>) => {
    if (!gameId) throw new Error("No game");
    const note = await apiCall<NoteDto>(getToken, gameNotePath(gameId, noteId), { method: "PATCH", body: JSON.stringify(patch) });
    await replace((list) => list.map((row) => (row.id === note.id ? note : row)));
    return note;
  }, [gameId, getToken, replace]);

  const remove = useCallback(async (noteId: string) => {
    if (!gameId) throw new Error("No game");
    const note = await apiCall<NoteDto>(getToken, gameNotePath(gameId, noteId), { method: "DELETE" });
    await replace((list) => list.filter((row) => row.id !== noteId));
    return note;
  }, [gameId, getToken, replace]);

  return {
    items,
    limit: req.data?.limit ?? GAME_NOTES_MAX,
    isLoading: req.isLoading,
    error: req.error,
    retry: () => void mutate(),
    create,
    update,
    remove,
  };
}

export type GameNotesController = ReturnType<typeof useGameNotes>;
