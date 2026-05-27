"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { apiCall, useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";

export type OpponentDiagnosticFinding = {
  code: string;
  severity: "ok" | "warn" | "info";
  message: string;
};

export type OpponentDiagnosticsResp = {
  pulseId: string;
  toonHandle: string | null;
  pulseCharacterId: string | null;
  displayNameSample: string | null;
  region: string | null;
  mmr: number | null;
  mmrFetchedAt: string | null;
  pulseResolveAttemptedAt: string | null;
  leagueId: number | null;
  gameCount: number;
  inReplayMmrCount: number;
  pulseIdStatus: "resolved" | "unresolved" | "none";
  mmrStatus: "present" | "missing";
  findings: OpponentDiagnosticFinding[];
};

export type OpponentRetryPulseResp = {
  resolvedPulseCharacterId: boolean;
  pulseCharacterId: string | null;
  mmr: number | null;
  region: string | null;
  gamesRestamped: number;
};

const PULSE_ID_STATUS: Record<string, string> = {
  resolved: "Resolved (linked)",
  unresolved: "Unresolved (toon only)",
  none: "No identity",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/**
 * "Why is data missing?" debug panel for one opponent. Surfaces the
 * stored identity / MMR state and a plain-language explanation of why
 * the Pulse ID shows "TOON" or the MMR shows "—", plus a Retry button
 * that forces a fresh SC2Pulse resolve + MMR refetch (bypassing the
 * cron throttle windows).
 *
 * Reused by the admin opponent drill-down (any user, always expanded)
 * and the user-facing opponent profile (own opponents only, collapsed
 * behind a toggle so it stays out of the way until asked for). The
 * endpoints differ only by base path; the API scopes both to the
 * caller's data server-side.
 *
 * When ``collapsible`` is set the diagnostics request is deferred until
 * the panel is opened, so a normal profile view doesn't fire the query
 * for every opponent.
 */
export function OpponentDiagnosticsPanel({
  diagnosticsPath,
  retryPath,
  collapsible = false,
}: {
  diagnosticsPath: string;
  retryPath: string;
  collapsible?: boolean;
}) {
  const { getToken } = useAuth();
  const [open, setOpen] = useState(!collapsible);
  const { data, error, isLoading, mutate } = useApi<OpponentDiagnosticsResp>(
    open ? diagnosticsPath : null,
    { revalidateOnFocus: false },
  );

  const [retry, setRetry] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "done"; resp: OpponentRetryPulseResp }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function runRetry() {
    setRetry({ kind: "busy" });
    try {
      const resp = await apiCall<OpponentRetryPulseResp>(getToken, retryPath, {
        method: "POST",
      });
      setRetry({ kind: "done", resp });
      await mutate();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRetry({ kind: "error", message });
    }
  }

  if (error && error.status === 404) return null;

  return (
    <Card padded>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {collapsible ? (
          <button
            type="button"
            className="text-body font-semibold text-text hover:text-accent"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "▾" : "▸"} Identity &amp; MMR diagnostics
          </button>
        ) : (
          <h2 className="text-body font-semibold text-text">
            Identity &amp; MMR diagnostics
          </h2>
        )}
        {open ? (
          <button
            type="button"
            className="btn btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
            disabled={retry.kind === "busy" || isLoading}
            onClick={runRetry}
          >
            {retry.kind === "busy" ? "Retrying…" : "Retry pulse resolve + MMR"}
          </button>
        ) : null}
      </div>

      {!open ? (
        <p className="mt-1 text-caption text-text-muted">
          Why this opponent&apos;s Pulse ID or MMR is missing — open to see.
        </p>
      ) : (
        <>
          <p className="mt-1 text-caption text-text-muted">
            Why the Pulse ID or MMR is missing for this opponent. Inferred from
            stored fields — Retry forces a fresh SC2Pulse lookup, bypassing the
            usual throttle window.
          </p>

          {isLoading && !data ? (
            <div className="mt-3">
              <Skeleton rows={4} />
            </div>
          ) : error ? (
            <p className="mt-3 text-caption text-danger">
              Failed to load diagnostics: {error.message}
            </p>
          ) : data ? (
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-caption sm:grid-cols-3">
                <DiagField label="Pulse ID" value={PULSE_ID_STATUS[data.pulseIdStatus]} />
                <DiagField
                  label="MMR"
                  value={data.mmrStatus === "present" ? "Present" : "Missing"}
                />
                <DiagField label="Character id" value={data.pulseCharacterId || "—"} mono />
                <DiagField label="Toon handle" value={data.toonHandle || "—"} mono />
                <DiagField label="Region" value={data.region || "—"} />
                <DiagField
                  label="MMR value"
                  value={data.mmr !== null ? String(data.mmr) : "—"}
                />
                <DiagField
                  label="In-replay MMR games"
                  value={`${data.inReplayMmrCount} / ${data.gameCount}`}
                />
                <DiagField label="MMR fetched" value={fmtDate(data.mmrFetchedAt)} />
                <DiagField
                  label="Resolve attempted"
                  value={fmtDate(data.pulseResolveAttemptedAt)}
                />
              </div>

              <ul className="space-y-1.5">
                {data.findings.map((f, i) => (
                  <li key={`${f.code}-${i}`} className="flex gap-2 text-caption">
                    <SeverityDot severity={f.severity} />
                    <span className="text-text-muted">{f.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {retry.kind === "done" ? (
            <p className="mt-3 rounded-md border border-success/40 bg-success/10 p-2 text-caption text-success">
              {retry.resp.resolvedPulseCharacterId
                ? `Resolved character id ${retry.resp.pulseCharacterId}. `
                : ""}
              {retry.resp.mmr !== null
                ? `MMR ${retry.resp.mmr}${retry.resp.region ? ` (${retry.resp.region})` : ""}. `
                : "SC2Pulse returned no current 1v1 MMR. "}
              {retry.resp.gamesRestamped > 0
                ? `Back-stamped ${retry.resp.gamesRestamped} game(s).`
                : ""}
            </p>
          ) : retry.kind === "error" ? (
            <p className="mt-3 rounded-md border border-danger/40 bg-danger/10 p-2 text-caption text-danger">
              Retry failed: {retry.message}
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

function DiagField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-text-dim">
        {label}
      </span>
      <span className={mono ? "break-all font-mono text-text" : "text-text"}>
        {value}
      </span>
    </div>
  );
}

function SeverityDot({ severity }: { severity: "ok" | "warn" | "info" }) {
  const color =
    severity === "ok"
      ? "bg-success"
      : severity === "warn"
        ? "bg-warning"
        : "bg-accent";
  return (
    <span
      className={`mt-1 h-2 w-2 shrink-0 rounded-full ${color}`}
      aria-hidden
    />
  );
}
