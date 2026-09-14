export type ExplorerView = "mmr-gap" | "periods" | "groups" | "execution" | "leads" | "breaks" | "rematches";
export type ExplorerControls = Record<string, string | number | boolean | undefined>;

export type ExplorerRow = {
  key: string;
  label: string;
  games: number;
  wins: number;
  losses: number;
  decided: number;
  winRate: number | null;
  players: number;
  avgDurationSec?: number | null;
  avgMmr?: number | null;
  medianSec?: number | null;
  p25Sec?: number | null;
  p75Sec?: number | null;
  winMedianSec?: number | null;
  lossMedianSec?: number | null;
};
export type ExplorerPlayer = { id: string; label: string; currentMmr?: number | null };
export type ExplorerResponse = {
  view: ExplorerView;
  totalGames: number;
  eligibleGames: number;
  preparation?: { pendingGames: number };
  notes: string[];
  rows: ExplorerRow[];
  breakdown?: Array<{ key: string; group: "a" | "b"; kind: "matchup" | "build"; label: string; games: number; wins: number; losses: number; decided: number; winRate: number | null }>;
  options: { players?: ExplorerPlayer[]; builds?: string[]; milestones?: Array<{ id: string; label: string }> };
};
export type ExplorerGame = {
  id: string;
  date: string | null;
  map: string | null;
  result: string | null;
  playerId: string | null;
  playerName: string | null;
  opponent: string | null;
  myRace: string | null;
  oppRace: string | null;
  myMmr: number | null;
  opponentMmr: number | null;
  build: string | null;
  durationSec: number | null;
};
export type ExplorerGamesResponse = { total: number; offset: number; limit: number; games: ExplorerGame[] };
