import { getJsonWithStatus } from "@/lib/serverApi";

/**
 * /definitions trust lines: "Matches N of M player corrections" per
 * released rule, from GET /v1/classifier-quality/labels (the nightly
 * check-in aggregate; at least three distinct players per label, counts
 * only). Disagreement volume, never an accuracy score.
 */
export type ClassifierTrust = Readonly<Record<string, { matches: number; corrections: number }>>;

/** The API refreshes nightly; an hour keeps the page close without per-view reads. */
export const CLASSIFIER_TRUST_REVALIDATE_SEC = 3600;
const TIMEOUT_MS = 4000;

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Keep only well-formed rows; anything else means "no trust lines". */
export function parseClassifierTrust(body: unknown): ClassifierTrust | null {
  const labels = body && typeof body === "object" ? (body as { labels?: unknown }).labels : null;
  if (!Array.isArray(labels)) return null;
  const out: Record<string, { matches: number; corrections: number }> = {};
  for (const row of labels) {
    const { label, matches, corrections } = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
    if (typeof label !== "string" || !label || !count(matches) || !count(corrections) || corrections === 0 || matches > corrections) continue;
    out[label] = { matches, corrections };
  }
  return out;
}

/** Server-side read for the definitions page; null when the API is unavailable. */
export async function fetchClassifierTrust(): Promise<ClassifierTrust | null> {
  try {
    const { data } = await getJsonWithStatus<unknown>("/v1/classifier-quality/labels", {
      revalidateSec: CLASSIFIER_TRUST_REVALIDATE_SEC,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return parseClassifierTrust(data);
  } catch {
    return null;
  }
}
