export type GamesChanged = { count: number; inserted: number; bulk: boolean; reason: string };

export function gamesChanged(value: unknown): GamesChanged {
  const row = value && typeof value === "object" ? value as Partial<GamesChanged> : {};
  const count = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return { count: count(row.count), inserted: count(row.inserted), bulk: row.bulk === true, reason: typeof row.reason === "string" ? row.reason : "unknown" };
}

/** One refresh clock for every chart consumer, without delaying live counters. */
export function createGamesRefresh(deliver: (value: GamesChanged) => void, setBulk: (value: boolean) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: GamesChanged | null = null;
  let firstAt = 0;
  let lastFlush = 0;
  let bulk = false;
  let recent: number[] = [];
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    const value = pending; pending = null; lastFlush = Date.now();
    if (value) deliver(value);
    if (recent.length === 0 || Date.now() - recent.at(-1)! >= 10000) { bulk = false; setBulk(false); }
  };
  return {
    receive(value: GamesChanged) {
      const now = Date.now();
      recent = [...recent.filter((at) => now - at < 10000), now];
      if (!pending) firstAt = now;
      pending = pending ? { count: pending.count + value.count, inserted: pending.inserted + value.inserted, bulk: pending.bulk || value.bulk, reason: pending.reason === value.reason ? value.reason : "mixed" } : { ...value };
      if (value.bulk || recent.length > 3) { bulk = true; setBulk(true); }
      if (bulk) pending.bulk = true;
      clearTimeout(timer);
      const deadline = bulk ? Math.max(firstAt, lastFlush) + 30000 : Math.min(now + 2000, firstAt + 10000);
      timer = setTimeout(flush, Math.max(0, deadline - now));
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { if (!pending) { bulk = false; setBulk(false); } }, 10000);
    },
    dispose() { clearTimeout(timer); clearTimeout(idleTimer); pending = null; recent = []; bulk = false; },
  };
}
