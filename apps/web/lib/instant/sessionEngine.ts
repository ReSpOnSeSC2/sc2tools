/**
 * The one `EngineClient` behind an Instant Analysis session, and its
 * lifecycle: created lazily on first need, optionally warmed up early,
 * released on dispose.
 *
 * Warm-up (`prewarm`) exists because starting CPython in WebAssembly
 * takes about two seconds even when every asset comes from the HTTP
 * cache. The views call it on the visitor's FIRST intent to add replays
 * (pressing a "Choose…" button, dragging files over the drop zone,
 * focusing the intake) — never on page load — so the engine is usually
 * ready by the time files are picked. It is idempotent, shares the boot
 * with the run that follows (the client dedupes boots), and stays silent
 * on failure: the run boots again and reports the error then.
 *
 * Example:
 *   const engine = new SessionEngine(() => createEngineClient());
 *   engine.prewarm();               // on pointerdown / dragenter / focus
 *   await engine.get().listPlayers(files);
 *   engine.dispose();               // on unmount
 */
import type { EngineClient } from "./types";

export class SessionEngine {
  private engine: EngineClient | null = null;
  private warmed = false;
  private disposed = false;
  private readonly disposeListeners: Array<() => void> = [];

  /**
   * Example:
   *   new SessionEngine(() => (options().clientFactory ?? createEngineClient)());
   */
  constructor(private readonly factory: () => EngineClient) {}

  /** The engine, created on first call (throws only if the factory does). */
  get(): EngineClient {
    this.engine ??= this.factory();
    return this.engine;
  }

  /** Start booting now (see module comment); no-op after the first call or once disposed. */
  prewarm(): void {
    if (this.disposed || this.warmed) return;
    this.warmed = true;
    try {
      // A failed warm-up is not the visitor's problem yet: the run that
      // follows boots again and shows the error if it fails too.
      void this.get().boot().catch(() => undefined);
    } catch {
      // The factory itself failed (no Worker support): the run reports it.
    }
  }

  /** Engine heap after the latest boot/parse, or null. */
  heapBytes(): number | null {
    return this.engine?.lastHeapBytes?.() ?? null;
  }

  /** True between `dispose()` and the next `activate()`. */
  isDisposed(): boolean {
    return this.disposed;
  }

  /** Run `listener` first thing on every `dispose()` (e.g. supersede the current run). */
  onDispose(listener: () => void): void {
    this.disposeListeners.push(listener);
  }

  /** Usable again after a dispose (React StrictMode mounts effects twice). */
  activate(): void {
    this.disposed = false;
  }

  /** Release the engine (terminates its worker); a later `get()` creates a new one. */
  dispose(): void {
    this.disposeListeners.forEach((listener) => listener());
    this.disposed = true;
    this.warmed = false;
    this.engine?.dispose();
    this.engine = null;
  }
}
