/** First-party signed-in hand-off attribution. No guessed anonymous identity. */
export async function recordAuthenticatedDownload(token: string | null): Promise<void> {
  if (!token) return;
  try {
    const base = (process.env.SC2TOOLS_API_BASE || process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8080").replace(/\/+$/, "");
    await fetch(`${base}/v1/me/activation/download`, { method: "POST", headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(2500) });
  } catch { /* Installer response and ordinary download totals remain independent. */ }
}
