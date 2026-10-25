"use client";

import Link from "next/link";
import { type ComponentProps, type ReactNode } from "react";
import { gameAnalysisHref, type OpponentNavigationContext } from "@/lib/opponentNavigation";
import { GameSourceProvider, useGameSource } from "@/lib/useGameSource";

export function GameSourceLabelProvider({ label, filters, replace, sampled, children }: { label: string; filters?: string; replace?: boolean; sampled?: boolean; children: ReactNode }) {
  return <GameSourceProvider label={label} filters={filters} replace={replace} sampled={sampled}>{children}</GameSourceProvider>;
}

export function GameAnalysisLink({ gameId, opponentContext, fromLabel, hash = "", ...props }: Omit<ComponentProps<typeof Link>, "href"> & {
  gameId: string;
  opponentContext?: OpponentNavigationContext | null;
  fromLabel?: string;
  hash?: string;
}) {
  const source = useGameSource(fromLabel);
  return <Link {...props} href={`${gameAnalysisHref(gameId, opponentContext, source)}${hash}`} />;
}
