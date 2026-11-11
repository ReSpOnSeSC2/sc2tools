import { getServerFormatter } from "@/lib/i18n/format";
/**
 * Client contract for the re-analysis center (GET/POST /v1/me/reanalysis).
 * Counts and states only: the API never sends game ids, paths or URLs here.
 */

export type ReanalysisAgentState = "ready" | "offline" | "update_required";
export type ReanalysisJobStatus =
  | "running"
  | "waiting_for_agent"
  | "update_required"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export interface ReanalysisCohort {
  id: string;
  kind: "engine" | "macro" | "engine-unknown";
  count: number;
  unknown?: number;
  engine?: string;
  date?: string;
  summary?: string;
  matchups?: string[];
}

export interface ReanalysisJob {
  id: string;
  cohortId: string;
  engine: string | null;
  status: ReanalysisJobStatus;
  total: number;
  processed: number;
  updated: number;
  unavailable: number;
  failed: number;
  etaSec: number | null;
  createdAt: string | null;
  completedAt: string | null;
}

export interface ReanalysisOverview {
  catalogRevision: string;
  cohorts: ReanalysisCohort[];
  job: ReanalysisJob | null;
  agent: ReanalysisAgentState;
}

const ACTIVE: ReadonlySet<ReanalysisJobStatus> = new Set(["running", "waiting_for_agent", "update_required", "paused"]);
const STATUSES: ReadonlySet<string> = new Set([...ACTIVE, "completed", "cancelled", "failed"]);
const AGENT: ReadonlySet<string> = new Set(["ready", "offline", "update_required"]);
const KINDS: ReadonlySet<string> = new Set(["engine", "macro", "engine-unknown"]);

const count = (value: unknown): number => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0);
const text = (value: unknown, max = 300): string | undefined => (typeof value === "string" && value.length <= max ? value : undefined);

export function isActiveJob(job: ReanalysisJob | null | undefined): job is ReanalysisJob {
  return Boolean(job && ACTIVE.has(job.status));
}

function normalizeJob(raw: unknown): ReanalysisJob | null {
  if (!raw || typeof raw !== "object") return null;
  const job = raw as Record<string, unknown>;
  if (typeof job.id !== "string" || typeof job.status !== "string" || !STATUSES.has(job.status)) return null;
  const processed = count(job.processed);
  return {
    id: job.id,
    cohortId: text(job.cohortId, 80) ?? "",
    engine: text(job.engine, 40) ?? null,
    status: job.status as ReanalysisJobStatus,
    total: Math.max(count(job.total), processed),
    processed,
    updated: count(job.updated),
    unavailable: count(job.unavailable),
    failed: count(job.failed),
    etaSec: Number.isSafeInteger(job.etaSec) && (job.etaSec as number) >= 0 ? (job.etaSec as number) : null,
    createdAt: text(job.createdAt, 40) ?? null,
    completedAt: text(job.completedAt, 40) ?? null,
  };
}

/** Defensive parse: an unexpected body renders as "unavailable", never as zero work. */
export function normalizeReanalysis(raw: unknown): ReanalysisOverview | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.cohorts) || typeof body.agent !== "string" || !AGENT.has(body.agent)) return null;
  const cohorts: ReanalysisCohort[] = [];
  for (const entry of body.cohorts.slice(0, 40)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.kind !== "string" || !KINDS.has(row.kind)) continue;
    cohorts.push({
      id: row.id,
      kind: row.kind as ReanalysisCohort["kind"],
      count: count(row.count),
      unknown: row.unknown === undefined ? undefined : count(row.unknown),
      engine: text(row.engine, 40),
      date: text(row.date, 10),
      summary: text(row.summary),
      matchups: Array.isArray(row.matchups) ? row.matchups.filter((m): m is string => typeof m === "string").slice(0, 9) : undefined,
    });
  }
  return {
    catalogRevision: text(body.catalogRevision, 64) ?? "",
    cohorts,
    job: normalizeJob(body.job),
    agent: body.agent as ReanalysisAgentState,
  };
}

/** "Engine 1.6.11 or older labels" style title for a cohort. */
export function cohortTitle(cohort: Pick<ReanalysisCohort, "kind" | "engine">): string {
  if (cohort.kind === "engine" && cohort.engine) return `Analyzed before engine ${cohort.engine}`;
  if (cohort.kind === "macro") return "Missing a macro score";
  return "Engine version unknown";
}

export function cohortTitleById(cohorts: ReanalysisCohort[], id: string): string {
  const cohort = cohorts.find((entry) => entry.id === id);
  if (cohort) return cohortTitle(cohort);
  return id.startsWith("engine-before:") ? `Analyzed before engine ${id.slice("engine-before:".length)}` : "Re-analysis";
}

/** "about 3 min" / "about 2 h 5 min"; under a minute reads "less than a minute". */
export function formatEta(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return "less than a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `about ${hours} h ${rest} min` : `about ${hours} h`;
}

/** Long date for a milestone's YYYY-MM-DD, in UTC so it never shifts a day. */
export function formatMilestoneDate(date: string | undefined): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const value = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(value.getTime())) return null;
  return getServerFormatter().date(value, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export const REANALYSIS_ERROR_COPY: Record<string, string> = {
  reanalysis_job_active: "A re-analysis is already running. Pause or cancel it first.",
  reanalysis_cohort_empty: "There are no games to re-analyze in this group any more.",
  reanalysis_cohort_unknown: "This group is no longer offered. Refresh the page.",
  reanalysis_job_changed: "The re-analysis changed in the meantime. Try again.",
  reanalysis_job_finished: "This re-analysis has already finished.",
  rate_limited: "Too many requests. Wait a moment and try again.",
};
