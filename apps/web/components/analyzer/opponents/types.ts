import type { GlobalPlayerIdentity } from "@/lib/opponentGroups";
import type { OpponentListDetails } from "@/lib/opponentListDetails";

export type OpenOpponent = (id: string, fromLink?: boolean) => boolean;
export type OpponentExportAction = { count: number; disabled: boolean; download: () => void };

export type Opp = OpponentListDetails & {
  pulseId: string;
  pulseCharacterId?: string | null;
  toonHandle?: string | null;
  race?: string | null;
  /** Distinct races observed in this account's qualifying game history. */
  races?: string[];
  region?: string | null;
  name?: string;
  displayNameSample?: string;
  // Revealed identity behind a barcode, from Pulse or an approved
  // community submission. The recorded account name stays separate.
  revealedName?: string | null;
  globalIdentity?: GlobalPlayerIdentity | null;
  wins: number;
  losses: number;
  games: number;
  gameCount?: number;
  winRate: number;
  mmr?: number | null;
  netMmr?: number | null;
  mmrWon?: number;
  mmrLost?: number;
  mmrPairs?: number;
  mmrAvgDelta?: number | null;
  lastPlayed: string | null;
  lastSeen?: string | null;
  notesMeta?: { preview: string };
  notes?: string;
};
export const notePreview = (opponent: Opp) => opponent.notesMeta?.preview || Array.from((opponent.notes || "").replace(/\s+/g, " ").trim()).slice(0, 140).join("");
