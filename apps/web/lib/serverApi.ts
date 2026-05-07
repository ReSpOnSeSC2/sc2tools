// Server-side fetcher used by the community pages so they can render
// at request time and ship clean HTML to crawlers.

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ||
  process.env.SC2TOOLS_API_BASE ||
  "http://localhost:8080";

export async function getJson<T>(
  path: string,
  opts: { revalidateSec?: number } = {},
): Promise<T | null> {
  // Default: no cache. The community list is the only place a freshly
  // published build needs to appear immediately, and a 60s ISR cache
  // was making "I just published it but it's not there" the most
  // common support thread. Pages that genuinely benefit from caching
  // can opt back in by passing a positive revalidateSec.
  const revalidate =
    typeof opts.revalidateSec === "number" && opts.revalidateSec > 0
      ? opts.revalidateSec
      : 0;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      // Public endpoints — no auth header needed.
      headers: { accept: "application/json" },
      next: { revalidate },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
