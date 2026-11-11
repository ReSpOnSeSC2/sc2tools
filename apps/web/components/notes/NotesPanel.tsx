"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { OpponentNotesCard as OpponentNotesCardImpl } from "@/components/analyzer/OpponentNotesCard";
import type { GameNotesPanel as GameNotesPanelImpl } from "./GameNotesPanel";

function LoadingNotes() {
  return <div role="status" aria-label="Loading notes" className="h-32 animate-pulse rounded-lg bg-bg-elevated" />;
}

// Each target's editor loads on demand, so neither page's first load pays for the other.
const GameNotesPanel = dynamic(() => import("./GameNotesPanel").then((module) => module.GameNotesPanel), { loading: LoadingNotes });
const OpponentNotesCard = dynamic(() => import("@/components/analyzer/OpponentNotesCard").then((module) => module.OpponentNotesCard), { loading: LoadingNotes });

export type NotesPanelProps =
  | ({ target: { kind: "opponent"; id: string } } & Omit<ComponentProps<typeof OpponentNotesCardImpl>, "pulseId">)
  | ({ target: { kind: "game"; id: string } } & ComponentProps<typeof GameNotesPanelImpl>);

/**
 * The notes panel for one target: an opponent account (its note with tags,
 * visibility and scope) or a game (private timestamped notes).
 */
export function NotesPanel(props: NotesPanelProps) {
  if (props.target.kind === "game") {
    const { target, ...rest } = props;
    void target;
    return <GameNotesPanel {...(rest as ComponentProps<typeof GameNotesPanelImpl>)} />;
  }
  const { target, ...rest } = props;
  return <OpponentNotesCard pulseId={target.id} {...(rest as Omit<ComponentProps<typeof OpponentNotesCardImpl>, "pulseId">)} />;
}
