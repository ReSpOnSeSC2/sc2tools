// Server-side fetcher used by the community pages so they can render
// at request time and ship clean HTML to crawlers.

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ||
  process.env.SC2TOOLS_API_BASE ||
  "http://localhost:8080";

export async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      // Public endpoints — no auth header needed.
      headers: { accept: "application/json" },
      // Revalidate every minute. Community lists don't churn fast and
      // a public crawler hammering the listing shouldn't blow the API.
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
