"use strict";

const busy = () => Object.assign(new Error("overlay_rotation_pending"), { status: 503, code: "overlay_rotation_pending", retryAfterSec: 1 });

/** Single API instance admission fence. Enrol synchronously before resolving a
 * credential; rotation closes admission before its first durable CAS, then
 * drains every admitted mutation. On restart no admitted work survives, and
 * the durable token rotation marker refuses new work. No per-chat DB leases.
 */
class OverlayTokenWrites {
  /** @param {(token:string)=>Promise<unknown>} resolve */
  constructor(resolve) {
    this.resolve = resolve;
    /** @type {Map<string, {count:number, idle:Set<()=>void>}>} */
    this.active = new Map();
    /** @type {Set<string>} */
    this.blocked = new Set();
  }

  /** @template T @param {string} token @param {()=>Promise<T>} work */
  async run(token, work) {
    if (this.blocked.has(token) || this.active.size >= 256 && !this.active.has(token)) throw busy();
    const entry = this.active.get(token) || { count: 0, idle: new Set() };
    if (entry.count >= 32) throw busy();
    entry.count++; this.active.set(token, entry);
    try {
      const owner = await this.resolve(token);
      if (!owner) throw Object.assign(new Error("invalid_overlay_token"), { status: 401, code: "invalid_overlay_token" });
      if (this.blocked.has(token)) throw busy();
      return await work();
    } finally {
      entry.count--;
      if (entry.count === 0) {
        this.active.delete(token);
        for (const idle of entry.idle) idle();
      }
    }
  }

  /** @param {string} token */
  block(token) { this.blocked.add(token); }
  /** @param {string} token */
  unblock(token) { this.blocked.delete(token); }
  /** A held writer leaves the durable operation retryable; never release it
   * early merely because the requesting browser disconnected.
   * @param {string} token @param {number} [timeoutMs] */
  async drain(token, timeoutMs = 1500) {
    const entry = this.active.get(token);
    if (!entry) return true;
    return new Promise(resolve => {
      const idle = () => { clearTimeout(timer); entry.idle.delete(idle); resolve(true); };
      const timer = setTimeout(() => { entry.idle.delete(idle); resolve(false); }, timeoutMs);
      entry.idle.add(idle);
    });
  }
}

module.exports = { OverlayTokenWrites, rotationBusy: busy };
