"use client";

import { useAuth } from "@clerk/nextjs";
import { useApi } from "@/lib/clientApi";
import { opponentNotePath, type NoteDto } from "@/lib/notes";
import { ScoutingNotePopover } from "@/components/scouting/ScoutingNotePopover";

/**
 * Quick note on this game's opponent from the game header: the same popover
 * as the live brief, loaded with the account's current note so a quick edit
 * never replaces text it did not show. Hidden until the opponent is one of
 * yours (a 404 means no synced row yet).
 */
export function GameOpponentNote({ pulseId }: { pulseId?: string | null }) {
  const { userId } = useAuth();
  const id = typeof pulseId === "string" && pulseId && pulseId.length <= 200 ? pulseId : null;
  const req = useApi<{ notes: string; note: NoteDto | null }>(id ? opponentNotePath(id) : null, { revalidateOnFocus: false, shouldRetryOnError: false });
  if (!id || !req.data) return null;
  const visibility = req.data.note?.visibility === "stream" ? "stream" : "private";
  return (
    <ScoutingNotePopover
      key={`${userId}:${id}`}
      pulseId={id}
      label={req.data.notes ? "Opponent note" : "Note on opponent"}
      initialNote={req.data.notes || ""}
      initialVisibility={visibility}
      onOpenChange={(open) => { if (!open) void req.mutate(); }}
    />
  );
}
