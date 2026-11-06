/** Server-only seed for background guide checks; uses the same purge tag as pages. */
import { cache } from "react";
import { GUIDE_CACHE_TAG, GUIDE_REVALIDATE_SEC } from "./api";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || process.env.SC2TOOLS_API_BASE || "http://localhost:8080";
const REVISION_TIMEOUT_MS = 1_500;

export const fetchGuideRevision = cache(async (): Promise<string | null> => {
  try {
    const response = await fetch(`${API_BASE.replace(/\/$/, "")}/v1/guides/revision`, {
      headers: { accept: "application/json" },
      next: { revalidate: GUIDE_REVALIDATE_SEC, tags: [GUIDE_CACHE_TAG] },
      redirect: "error", signal: AbortSignal.timeout(REVISION_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return null;
    const revision = (body as { revision?: unknown }).revision;
    return typeof revision === "string" && /^[A-Za-z0-9-]{1,128}$/.test(revision) ? revision : null;
  } catch {
    // Older API deployments and optional-check failures must not fail guide rendering.
    return null;
  }
});
