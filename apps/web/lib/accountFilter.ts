import rules from "../../api/src/config/accountFilter.json";

const HANDLE = new RegExp(rules.handlePattern, "i");
export const MAX_FILTER_ACCOUNTS = rules.maximumAccounts;
export type GameAccount = { handle: string; label: string; region: string; leagueId: number | null; mmr: number | null };

/** An explicit invalid cohort must never turn into All accounts. */
export function accountHandles(raw: unknown): string[] {
  if (raw === undefined || raw === "") return [];
  const values = typeof raw === "string" ? raw.split(",") : raw;
  if (!Array.isArray(values) || values.length === 0 || values.length > rules.maximumAccounts || values.some(value => typeof value !== "string" || value.length > rules.maximumHandleLength || !HANDLE.test(value.trim()))) {
    throw new Error("Choose up to 20 valid account handles.");
  }
  return [...new Set(values.map(value => value.trim().toUpperCase()))].sort();
}

export function accountFilter(raw: unknown): string | undefined {
  const handles = accountHandles(raw);
  return handles.length ? handles.join(",") : undefined;
}

/** Defensive presentation only: labels can fail without widening a selection. */
export function gameAccounts(raw: unknown): GameAccount[] {
  if (!Array.isArray(raw)) return [];
  const accounts = new Map<string, GameAccount>();
  for (const row of raw.slice(0, MAX_FILTER_ACCOUNTS)) {
    if (!row || typeof row !== "object") continue;
    try {
      const handles = accountHandles(row.handle);
      if (handles.length !== 1) continue;
      const handle = handles[0], safe = (value: unknown, max: number) => typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : "";
      accounts.set(handle, { handle, label: safe(row.label, 100) || handle, region: safe(row.region, 12),
        leagueId: Number.isInteger(row.leagueId) && row.leagueId >= 0 && row.leagueId <= 6 ? row.leagueId : null,
        mmr: typeof row.mmr === "number" && Number.isFinite(row.mmr) && row.mmr >= 0 ? row.mmr : null });
    } catch { /* Ignore malformed label rows; keep active handles separately. */ }
  }
  return [...accounts.values()];
}

const LEAGUES = ["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster"];
export function accountLabel(account: GameAccount): string {
  return [account.label, account.region, account.leagueId !== null ? LEAGUES[account.leagueId] : null].filter(Boolean).join(" · ");
}
