/** Throwing keeps a temporary profile outage out of the ISR page cache. */
export class PublicFetchError extends Error {
  constructor(public readonly status: number | null) {
    super("Public profile temporarily unavailable");
    this.name = "PublicFetchError";
  }
}
