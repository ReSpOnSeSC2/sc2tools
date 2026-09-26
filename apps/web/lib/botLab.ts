export type BotRace = "Protoss" | "Terran" | "Zerg";
export type BotLabCatalog = {
  enabled: true;
  devices: Array<{ id: string; label: string }>;
  deviceId: string | null;
  agent: { available: boolean; ready: boolean; code?: string; message?: string };
  bots: Array<{ id: string; label: string; race: string; updates: number; maxApm: number; cameraRestricted: boolean }>;
  maps: Array<{ id: string; label: string }>;
  activeSessionId: string | null;
  startWorkers: 8;
};
export type BotLabStart = {
  deviceId: string;
  requestId: string;
  mapId: string;
  botId: string;
  humanRace: BotRace;
};
export type BotLabSession = {
  id: string;
  sessionId?: string;
  deviceId: string;
  status: "starting" | "playing" | "finished" | "closed" | "failed" | "unknown";
  humanRace?: string;
  botRace?: string;
  botLabel?: string;
  map?: string;
  result?: string;
  error?: string;
};
export type SavedBotSession = { id: string; deviceId: string; start?: BotLabStart };

export function botSessionActive(status?: BotLabSession["status"]) {
  return !status || status === "starting" || status === "playing" || status === "unknown";
}

export function readSavedBotSession(value: string | null): SavedBotSession | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as SavedBotSession;
    if (!/^[a-f0-9]{32}$/.test(parsed.id) || typeof parsed.deviceId !== "string" || !parsed.deviceId) return null;
    const start = parsed.start;
    if (start && (start.requestId !== parsed.id || start.deviceId !== parsed.deviceId ||
      typeof start.mapId !== "string" || typeof start.botId !== "string" ||
      !["Protoss", "Terran", "Zerg"].includes(start.humanRace))) return null;
    return { id: parsed.id, deviceId: parsed.deviceId, ...(start ? { start } : {}) };
  } catch { return null; }
}
