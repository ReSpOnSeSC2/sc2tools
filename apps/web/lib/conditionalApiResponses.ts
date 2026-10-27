import {
  conditionalCapability, conditionalRoute, rejectConditionalAuth, type ConditionalApiScope,
} from "./conditionalApiScope";

type Limits = { bytes: number; bodyBytes: number; keyBytes: number; entries: number; active: number; ttlMs: number };
type Options = { limits?: Partial<Limits>; now?: () => number };
const LIMITS: Limits = { bytes: 8 * 1024 * 1024, bodyBytes: 512 * 1024, keyBytes: 16 * 1024,
  entries: 64, active: 4, ttlMs: 600_000 };
const ENTRY_ALLOWANCE = 256, MAX_TAG_BYTES = 72;
type Entry = { key: string; scope: ConditionalApiScope; body: string | null; tag: string;
  charge: number; refs: number; cached: boolean; freed: boolean; expiresAt: number; sequence: number };
export type ConditionalRead<T> = {
  scope: ConditionalApiScope; owner: string; origin: string; path: string;
  assertCurrent: () => void; fetchResponse: (tag?: string) => Promise<Response>;
  ordinary: () => Promise<T>; fail: (res: Response) => Promise<never>;
};
type Operation<T> = { input: ConditionalRead<T>; key: string; keyBytes: number; route: number;
  pin?: Entry; generation: object; started: number; reservation: number };

/** UTF-8 charge without allocating an encoded copy. Oversized valid bodies still return. */
function utf8Bytes(text: string, stopAt = Infinity) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index += 1; }
    else bytes += 3;
    if (bytes > stopAt) break;
  }
  return bytes;
}

/** Logical representation budget only: excludes decoder, DTO, SWR and VM heap. */
class ConditionalResponses {
  private readonly limits: Limits;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly registered = new WeakSet<ConditionalApiScope>();
  private bytes = 0;
  private reserved = 0;
  private active = 0;
  private liveEntries = 0;
  private retiredPins = 0;
  private sequence = 0;

  constructor(options: Options) {
    this.limits = { ...LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error("invalid_conditional_limits");
    }
  }
  snapshot() {
    return { bytes: this.bytes, reserved: this.reserved, active: this.active,
      entries: this.entries.size, liveEntries: this.liveEntries, retiredPins: this.retiredPins };
  }
  private free(entry: Entry) {
    if (entry.freed) return;
    entry.freed = true; entry.body = null; this.bytes -= entry.charge; this.liveEntries -= 1;
  }
  private retire(entry: Entry) {
    if (!entry.cached) return;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    entry.cached = false;
    if (entry.refs) this.retiredPins += 1; else this.free(entry);
  }
  private release(entry: Entry) {
    entry.refs -= 1;
    if (!entry.refs && !entry.cached) { this.retiredPins -= 1; this.free(entry); }
  }
  private retireScope(scope: ConditionalApiScope) {
    for (const entry of this.entries.values()) if (entry.scope === scope) this.retire(entry);
  }
  private assert<T>(input: ConditionalRead<T>) {
    input.assertCurrent();
    if (!input.scope.active || input.scope.retired || input.scope.owner !== input.owner) {
      throw new DOMException("This account request is no longer current.", "AbortError");
    }
  }
  private reserve(charge: number, protectedEntry: Entry | undefined) {
    if (this.active >= this.limits.active) return false;
    while (this.bytes + this.reserved + charge > this.limits.bytes
      || this.liveEntries + this.active + 1 > this.limits.entries) {
      let victim: Entry | undefined;
      for (const entry of this.entries.values()) if (entry !== protectedEntry && !entry.refs) { victim = entry; break; }
      if (!victim) return false;
      this.retire(victim);
    }
    this.reserved += charge; this.active += 1;
    return true;
  }
  private admit<T>(input: ConditionalRead<T>): Operation<T> | null {
    const route = conditionalRoute(input.path), scope = input.scope;
    if (route < 0 || !(scope.capabilities & (1 << route))) return null;
    const key = JSON.stringify([input.origin, scope.id, input.owner, input.path]);
    const keyBytes = utf8Bytes(key, this.limits.keyBytes);
    if (keyBytes > this.limits.keyBytes) return null;
    if (!this.registered.has(scope)) {
      this.registered.add(scope);
      scope.onRetire.add(() => this.retireScope(scope));
    }
    for (const entry of this.entries.values()) if (entry.expiresAt <= this.now()) this.retire(entry);
    const pin = this.entries.get(key);
    const reservation = this.limits.bodyBytes + keyBytes + MAX_TAG_BYTES + ENTRY_ALLOWANCE;
    if (!this.reserve(reservation, pin)) return null;
    if (pin) { pin.refs += 1; this.entries.delete(key); this.entries.set(key, pin); }
    return { input, key, keyBytes, route, pin, generation: scope.retention, started: ++this.sequence, reservation };
  }
  private current<T>(op: Operation<T>) {
    return op.generation === op.input.scope.retention && !!(op.input.scope.capabilities & (1 << op.route));
  }
  private retirePrevious<T>(op: Operation<T>) {
    const entry = this.entries.get(op.key);
    if (entry && entry.sequence <= op.started) this.retire(entry);
  }
  private async reconstruct<T>(op: Operation<T>, res: Response): Promise<T> {
    const { pin, input } = op;
    if (this.current(op) && pin?.body !== null && pin?.body !== undefined
      && pin.expiresAt > this.now() && res.headers.get("etag") === pin.tag) {
      const result: T = JSON.parse(pin.body);
      this.assert(input);
      return result;
    }
    if (pin && this.entries.get(op.key) === pin) this.retire(pin);
    // Exactly one unconditional recovery; clientApi gives a second304 a clear Retry error.
    const result = await input.ordinary();
    this.assert(input);
    return result;
  }
  private async baselineBody<T>(op: Operation<T>, res: Response): Promise<T> {
    if (this.current(op)) {
      op.input.scope.capabilities &= ~(1 << op.route);
      this.retirePrevious(op);
    }
    const result: T = await res.json();
    this.assert(op.input);
    return result;
  }
  private publish<T>(op: Operation<T>, text: string, tag: string) {
    if (!this.current(op)) return;
    const current = this.entries.get(op.key);
    if (current && current.sequence > op.started) return;
    const bodyBytes = utf8Bytes(text, this.limits.bodyBytes);
    this.retirePrevious(op);
    if (bodyBytes > this.limits.bodyBytes) return;
    const charge = bodyBytes + op.keyBytes + utf8Bytes(tag) + ENTRY_ALLOWANCE;
    this.reserved -= op.reservation; op.reservation = 0;
    const entry: Entry = { key: op.key, scope: op.input.scope, body: text, tag, charge,
      refs: 0, cached: true, freed: false, expiresAt: this.now() + this.limits.ttlMs, sequence: op.started };
    this.entries.set(op.key, entry); this.bytes += charge; this.liveEntries += 1;
  }
  private async retainedBody<T>(op: Operation<T>, res: Response): Promise<T> {
    const tag = res.headers.get("etag")!;
    const text = await res.text();
    this.assert(op.input);
    const result: T = JSON.parse(text);
    this.assert(op.input);
    this.publish(op, text, tag);
    return result;
  }
  async read<T>(input: ConditionalRead<T>): Promise<T> {
    this.assert(input);
    const op = this.admit(input);
    if (!op) return input.ordinary();
    try {
      const res = await input.fetchResponse(op.pin?.tag);
      this.assert(input);
      if (res.status === 304) return await this.reconstruct(op, res);
      if (!res.ok) {
        rejectConditionalAuth(input.scope, input.owner, res.status);
        return await input.fail(res);
      }
      if (!conditionalCapability(res)) return await this.baselineBody(op, res);
      return await this.retainedBody(op, res);
    } finally {
      // Actual fetch/body work owns these; caller timeout must not free them.
      if (op.pin) this.release(op.pin);
      this.reserved -= op.reservation; this.active -= 1;
    }
  }
}

/** One production instance per document, including debt from retired providers. */
export const createConditionalApiResponses = (options: Options = {}) => new ConditionalResponses(options);
const documentResponses = createConditionalApiResponses();
export const readConditionalApi = <T,>(input: ConditionalRead<T>) => documentResponses.read(input);
