/** One client-side query transport shared by global filters and section state.
 * Pending router acknowledgements may arrive after newer input. Keep their
 * patches composable, and fence every deferred write across Back/Forward. */
export type QueryLocation = { path: string; search: string; key: string };
export function queryLocation(path: string, search: string): QueryLocation {
  const normalized = new URLSearchParams(search).toString();
  return { path, search: normalized, key: `${path}${normalized ? `?${normalized}` : ""}` };
}
export function browserQueryLocation(): QueryLocation | null {
  return typeof window === "undefined" ? null : queryLocation(window.location.pathname, window.location.search);
}
export type QueryWriteGuard = { epoch: number; path: string; browser: string };
export class UrlQueryNavigation {
  epoch = 0;
  observed = "";
  expected = "";
  path = "";
  params = new URLSearchParams();
  pending = new Set<string>();
  known = new Set<string>();
  reset(location: QueryLocation) {
    this.epoch++; this.observed = location.key; this.expected = location.key;
    this.path = location.path; this.params = new URLSearchParams(location.search); this.pending.clear(); this.known.clear();
  }
  observe(location: QueryLocation) {
    if (!this.path) { this.reset(location); return; }
    if (this.observed === location.key) return;
    const owned = this.pending.delete(location.key);
    if (!owned) { this.reset(location); return; }
    if (location.key === this.expected) { this.path = location.path; this.params = new URLSearchParams(location.search); }
    this.observed = location.key;
  }
  guard(browser: QueryLocation): QueryWriteGuard {
    return { epoch: this.epoch, path: this.path, browser: browser.key };
  }
  prepare(update: (params: URLSearchParams) => URLSearchParams, browser: QueryLocation, guard?: QueryWriteGuard): string | null {
    if (guard && (guard.epoch !== this.epoch || guard.path !== browser.path || browser.key !== guard.browser && !this.known.has(browser.key))) return null;
    if (browser.path !== this.path || browser.key !== this.observed && browser.key !== this.expected && !this.pending.has(browser.key)) this.reset(browser);
    const next = update(new URLSearchParams(this.params));
    const href = `${this.path}${next.size ? `?${next}` : ""}`;
    if (href === this.expected) return null;
    this.params = next; this.expected = href; this.pending.add(href); this.known.add(href);
    if (this.known.size > 16) { const oldest = this.known.values().next().value!; this.known.delete(oldest); this.pending.delete(oldest); }
    return href;
  }
}
