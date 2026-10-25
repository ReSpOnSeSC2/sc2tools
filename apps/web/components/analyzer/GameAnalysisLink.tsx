"use client";

import Link from "next/link";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { gameAnalysisHref, type OpponentNavigationContext } from "@/lib/opponentNavigation";
import { useGameSource } from "@/lib/useGameSource";

const SourceLabelContext = createContext<string | undefined>(undefined);
export function GameSourceLabelProvider({ label, children }: { label: string; children: ReactNode }) {
  return <SourceLabelContext.Provider value={label}>{children}</SourceLabelContext.Provider>;
}

export function GameAnalysisLink({ gameId, opponentContext, fromLabel, hash = "", ...props }: Omit<ComponentProps<typeof Link>, "href"> & {
  gameId: string;
  opponentContext?: OpponentNavigationContext | null;
  fromLabel?: string;
  hash?: string;
}) {
  const contextLabel = useContext(SourceLabelContext);
  const source = useGameSource(fromLabel ?? contextLabel);
  return <Link {...props} href={`${gameAnalysisHref(gameId, opponentContext, source)}${hash}`} />;
}
