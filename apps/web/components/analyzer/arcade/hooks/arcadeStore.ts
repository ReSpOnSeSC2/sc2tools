/**
 * arcadeStore — one shared, server-persisted ArcadeState per account.
 *
 * Every Arcade surface (runner, Stock Market, Buildle, Bingo, shop …)
 * calls useArcadeState(). Each call used to own a private copy of the
 * blob and PUT the whole thing on its own debounce, so the last writer
 * silently dropped every other instance's changes (e.g. a Stock Market
 * lock-in erased the play record the runner saved alongside it). All
 * instances now read and write this one store:
 *
 *   - one hydrate (GET) per store, deduped across instances;
 *   - mutations issued before hydrate are queued and replayed on top of
 *     the remote state, so a mount-time seed can't overwrite saved
 *     progress with defaults;
 *   - one debounced PUT that always sends the latest merged state;
 *     PUTs are chained so an older body can never land after a newer one;
 *   - when the last subscriber unmounts, pending work flushes at once and
 *     the next mount re-hydrates (after that flush), like a fresh mount.
 */

import { apiCall } from "@/lib/clientApi";
import { levelForXp } from "../ArcadeEngine";
import { ARCADE_STATE_DEFAULT, type ArcadeState } from "../types";

export const ARCADE_PREF_PATH = "/v1/me/preferences/arcade";
export const FLUSH_DEBOUNCE_MS = 600;

export type ArcadeMutator = (prev: ArcadeState) => ArcadeState;
type TokenGetter = () => Promise<string | null>;

export interface ArcadeSnapshot {
  state: ArcadeState;
  hydrated: boolean;
}

function withLevel(state: ArcadeState): ArcadeState {
  // Recompute level off raw xp on every write so it never drifts.
  return { ...state, xp: { total: state.xp.total, level: levelForXp(state.xp.total) } };
}

export class ArcadeStore {
  private snapshot: ArcadeSnapshot = { state: ARCADE_STATE_DEFAULT, hydrated: false };
  private readonly listeners = new Set<() => void>();
  private queued: ArcadeMutator[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private hydrateStarted = false;
  private generation = 0;
  private inflight: Promise<void> = Promise.resolve();
  private getToken: TokenGetter = async () => null;

  /**
   * @param persist signed-in stores GET/PUT the server blob; signed-out
   *   (and auth-loading) stores are local-only, as before.
   */
  constructor(private readonly persist: boolean) {}

  getSnapshot = (): ArcadeSnapshot => this.snapshot;

  setTokenGetter(getToken: TokenGetter): void {
    this.getToken = getToken;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.ensureHydrated();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.release();
    };
  };

  /** Apply a mutation now, or queue it until hydrate completes. */
  update(mut: ArcadeMutator): void {
    if (!this.snapshot.hydrated) {
      this.queued.push(mut);
      return;
    }
    const next = mut(this.snapshot.state);
    if (next === this.snapshot.state) return;
    this.publish({ state: withLevel(next), hydrated: true });
    this.scheduleFlush();
  }

  /** Resolves once every PUT issued so far has settled (tests, unload). */
  whenIdle(): Promise<void> {
    return this.inflight;
  }

  private ensureHydrated(): void {
    if (this.hydrateStarted) return;
    this.hydrateStarted = true;
    const generation = ++this.generation;
    if (!this.persist) {
      this.finishHydrate(generation, ARCADE_STATE_DEFAULT);
      return;
    }
    void (async () => {
      // Never read the server before our own pending writes land.
      await this.inflight;
      let base: ArcadeState = ARCADE_STATE_DEFAULT;
      try {
        const remote = await apiCall<Partial<ArcadeState>>(this.getToken, ARCADE_PREF_PATH);
        if (remote && typeof remote === "object" && Object.keys(remote).length > 0) {
          base = { ...ARCADE_STATE_DEFAULT, ...remote } as ArcadeState;
        }
      } catch {
        // Treat a read error as "no state yet" but still replay queued
        // mutations so the session isn't silently dropped.
      }
      this.finishHydrate(generation, base);
    })();
  }

  private finishHydrate(generation: number, base: ArcadeState): void {
    if (generation !== this.generation) return; // superseded by a re-hydrate
    // Queued mutators must be idempotent against already-populated
    // targets (buildle/bingo seeds check before overwriting).
    const queue = this.queued;
    this.queued = [];
    let state = base;
    for (const mut of queue) state = mut(state);
    this.publish({ state: withLevel(state), hydrated: true });
    if (queue.length > 0) this.scheduleFlush();
  }

  private release(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) this.flush();
    // The next mount re-reads the server (other devices may have played),
    // after the flush above because hydrate awaits `inflight`.
    this.hydrateStarted = false;
    this.generation += 1;
    this.snapshot = { ...this.snapshot, hydrated: false };
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private flush(): void {
    this.dirty = false;
    if (!this.persist) return;
    const getToken = this.getToken;
    this.inflight = this.inflight.then(async () => {
      try {
        // Serialize at send time so the newest merged state goes out.
        await apiCall(getToken, ARCADE_PREF_PATH, {
          method: "PUT",
          body: JSON.stringify(this.snapshot.state),
        });
      } catch {
        // Persistence failures are non-fatal — local state still
        // reflects the user's progress for this session.
      }
    });
  }

  private publish(next: ArcadeSnapshot): void {
    this.snapshot = next;
    for (const listener of Array.from(this.listeners)) listener();
  }
}

const stores = new Map<string, ArcadeStore>();

/**
 * The shared store for one account. ``key`` is null while Clerk is still
 * loading; that store is local-only, matching the old behaviour.
 */
export function arcadeStoreFor(key: string | null, persist: boolean): ArcadeStore {
  const id = key === null ? "__auth-loading__" : `${persist ? "user" : "local"}:${key}`;
  let store = stores.get(id);
  if (!store) {
    store = new ArcadeStore(persist && key !== null);
    stores.set(id, store);
  }
  return store;
}

/** Test-only: forget every store so each test starts from scratch. */
export function resetArcadeStoresForTests(): void {
  stores.clear();
}
