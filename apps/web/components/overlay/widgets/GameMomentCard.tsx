"use client";
import { GAME_MOMENT_LABELS, momentCardEvent, type GameMoment } from "@/lib/gameMoments";
import { ChatAlertCard } from "./ChatAlertCard";
import type { AlertVisualMotion, AlertVisualPreset } from "@/lib/multichat/alerts";
export function GameMomentCard({ moment, preset, motion, preview = false }: { moment: GameMoment; preset: AlertVisualPreset; motion: AlertVisualMotion; preview?: boolean }) {
  return <ChatAlertCard event={momentCardEvent(moment)} preset={preset} motion={motion} preview={preview} sourceLabel="Ladder" kindLabel={GAME_MOMENT_LABELS[moment.kind]} />;
}
