type Race = "Protoss" | "Terran" | "Zerg" | "Random";
type ViewerGame = { result: "win" | "loss"; opponentRace: Race | null; map: string | null };
export type StreamViewerPage = { games: ViewerGame[]; wins: number; losses: number; delayMinutes: number };
export type StreamViewerSettings = {
  eligible: boolean;
  tokenId: string | null;
  delayMinutes: number;
  revision: number;
  href: string | null;
  sources: { id: string; label: string }[];
};

const RACES = new Set<unknown>(["Protoss", "Terran", "Zerg", "Random", null]);
export const STREAM_VIEWER_MIN_DELAY = 5;
export const STREAM_VIEWER_MAX_DELAY = 60;

export function validStreamViewerDelay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= STREAM_VIEWER_MIN_DELAY && value <= STREAM_VIEWER_MAX_DELAY;
}

function publicGame(input: unknown): ViewerGame | null {
  if (!input || typeof input !== "object") return null;
  const { result, opponentRace, map } = input as Record<string, unknown>;
  if ((result !== "win" && result !== "loss") || !RACES.has(opponentRace)
    || (map !== null && (typeof map !== "string" || map.length > 80))) return null;
  return { result, opponentRace: opponentRace as Race | null, map };
}

export function parseStreamViewer(input: unknown): StreamViewerPage | null {
  if (!input || typeof input !== "object") return null;
  const { games, wins, losses, delayMinutes } = input as Record<string, unknown>;
  if (!Array.isArray(games) || games.length > 30 || !validStreamViewerDelay(delayMinutes)) return null;
  const parsed = games.map(publicGame);
  if (parsed.some(game => game === null)) return null;
  const winCount = parsed.filter(game => game?.result === "win").length;
  if (wins !== winCount || losses !== parsed.length - winCount) return null;
  return { games: parsed.filter(game => game !== null), wins, losses, delayMinutes };
}
