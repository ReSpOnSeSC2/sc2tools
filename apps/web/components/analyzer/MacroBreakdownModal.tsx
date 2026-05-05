"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useApi, apiCall } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

/**
 * MacroBreakdownModal — port of the SPA's macro breakdown drilldown.
 *
 * Opens against `/v1/games/:gameId/macro-breakdown`. The endpoint
 * returns the stored breakdown blob for the game; an empty `raw`
 * object means the agent has not parsed leaks yet, so the user can
 * trigger a recompute (POST same path) which broadcasts a request
 * to their connected SC2 agent.
 */
export interface MacroBreakdownModalProps {
  open: boolean;
  onClose: () => void;
  gameId: string;
  initialScore?: number | null;
}

type Leak = {
  name?: string;
  detail?: string;
  penalty?: number;
  mineral_cost?: number;
};

type BreakdownRaw = {
  sq?: number;
  base_score?: number;
  supply_block_penalty?: number;
  race_penalty?: number;
  float_penalty?: number;
  injects_actual?: number | null;
  injects_expected?: number | null;
  chronos_actual?: number | null;
  chronos_expected?: number | null;
  mules_actual?: number | null;
  mules_expected?: number | null;
  supply_blocked_seconds?: number | null;
  mineral_float_spikes?: number | null;
};

type MacroResp = {
  ok: boolean;
  macro_score?: number | null;
  race?: string;
  game_length_sec?: number;
  raw?: BreakdownRaw;
  all_leaks?: Leak[];
  top_3_leaks?: Leak[];
};

const RACE_DETAIL: Record<
  "Zerg" | "Protoss" | "Terran",
  {
    title: string;
    actualKey: keyof BreakdownRaw;
    expectedKey: keyof BreakdownRaw;
    unitPlural: string;
    winCopy: string;
    penaltyLabel: string;
  }
> = {
  Zerg: {
    title: "Inject Efficiency",
    actualKey: "injects_actual",
    expectedKey: "injects_expected",
    unitPlural: "injects",
    winCopy: "Inject cadence kept up with hatchery uptime.",
    penaltyLabel: "Inject penalty",
  },
  Protoss: {
    title: "Chrono Efficiency",
    actualKey: "chronos_actual",
    expectedKey: "chronos_expected",
    unitPlural: "chronos",
    winCopy: "Chrono usage matched nexus uptime.",
    penaltyLabel: "Chrono penalty",
  },
  Terran: {
    title: "MULE Efficiency",
    actualKey: "mules_actual",
    expectedKey: "mules_expected",
    unitPlural: "MULEs",
    winCopy: "MULE drops kept pace with orbital energy.",
    penaltyLabel: "MULE penalty",
  },
};

export function MacroBreakdownModal({
  open,
  onClose,
  gameId,
  initialScore,
}: MacroBreakdownModalProps) {
  const { getToken } = useAuth();
  const { data, error, isLoading, mutate } = useApi<MacroResp>(
    open ? `/v1/games/${encodeURIComponent(gameId)}/macro-breakdown` : null,
    { revalidateOnFocus: false },
  );
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setRecomputeMsg(null);
      setRecomputing(false);
    }
  }, [open]);

  async function recompute() {
    if (recomputing) return;
    setRecomputeMsg(null);
    setRecomputing(true);
    try {
      await apiCall<{ ok: boolean; requested?: boolean; persisted?: boolean }>(
        getToken,
        `/v1/games/${encodeURIComponent(gameId)}/macro-breakdown`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setRecomputeMsg(
        "Recompute requested — your SC2 agent will re-parse the replay shortly.",
      );
      // Re-fetch so any persisted update appears immediately.
      mutate();
    } catch (err) {
      const e = err as { message?: string };
      setRecomputeMsg(e.message || "Recompute failed.");
    } finally {
      setRecomputing(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Macro breakdown"
      description={`Game ${gameId}`}
      size="xl"
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          {recomputeMsg ? (
            <span className="mr-auto text-caption text-text-muted">
              {recomputeMsg}
            </span>
          ) : null}
          <Button
            variant="secondary"
            onClick={recompute}
            loading={recomputing}
            disabled={recomputing}
          >
            {recomputing ? "Recomputing…" : "Recompute"}
          </Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      }
    >
      {isLoading ? (
        <p className="text-caption text-text-muted">Loading macro breakdown…</p>
      ) : error ? (
        <ErrorPanel
          status={error.status}
          message={error.message}
          onRecompute={recompute}
          recomputing={recomputing}
        />
      ) : !data ? null : (
        <BreakdownBody data={data} initialScore={initialScore} />
      )}
    </Modal>
  );
}

/* ============================================================
 * Body
 * ============================================================ */

function BreakdownBody({
  data,
  initialScore,
}: {
  data: MacroResp;
  initialScore?: number | null;
}) {
  const score =
    typeof data.macro_score === "number"
      ? data.macro_score
      : initialScore ?? null;
  const raw: BreakdownRaw = data.raw || {};
  const leaks =
    (data.all_leaks && data.all_leaks.length > 0
      ? data.all_leaks
      : data.top_3_leaks) || [];
  const effectiveRace =
    data.race === "Zerg" || data.race === "Protoss" || data.race === "Terran"
      ? data.race
      : raw.injects_actual != null
        ? "Zerg"
        : raw.chronos_actual != null
          ? "Protoss"
          : raw.mules_actual != null
            ? "Terran"
            : null;
  const detail = effectiveRace ? RACE_DETAIL[effectiveRace] : null;
  const headlineColour =
    typeof score !== "number"
      ? "text-text-dim"
      : score >= 75
        ? "text-success"
        : score >= 50
          ? "text-warning"
          : "text-danger";

  const wins: string[] = [];
  if ((raw.supply_block_penalty || 0) <= 0)
    wins.push("No meaningful supply block — production never stalled.");
  if (detail && (raw.race_penalty || 0) <= 0) wins.push(detail.winCopy);
  if ((raw.float_penalty || 0) <= 0)
    wins.push("Bank stayed under control — no sustained float.");
  if (typeof raw.sq === "number" && raw.sq >= 80) {
    wins.push(
      `Spending Quotient ${raw.sq.toFixed(0)} — Master/Pro-tier macro pacing.`,
    );
  } else if (typeof raw.sq === "number" && raw.sq >= 70) {
    wins.push(
      `Spending Quotient ${raw.sq.toFixed(0)} — solid Diamond-tier macro pacing.`,
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline gap-3">
        <span className="text-caption uppercase tracking-wider text-text-dim">
          Macro Breakdown
        </span>
        <span
          className={`text-3xl font-bold tabular-nums ${headlineColour}`}
          aria-label={
            typeof score === "number"
              ? `Score ${score} of 100`
              : "Score not computed"
          }
        >
          {typeof score === "number" ? score : "—"}
          <span className="ml-1 text-body text-text-dim font-normal">
            / 100
          </span>
        </span>
      </header>

      <div className="grid gap-3 md:grid-cols-2">
        <CalcPanel raw={raw} headlineColour={headlineColour} score={score} detail={detail} />
        <WinsAndLeaksPanel wins={wins} leaks={leaks} />
      </div>

      <DisciplineMetricsPanel raw={raw} detail={detail} />
    </div>
  );
}

function CalcPanel({
  raw,
  headlineColour,
  score,
  detail,
}: {
  raw: BreakdownRaw;
  headlineColour: string;
  score: number | null;
  detail: (typeof RACE_DETAIL)[keyof typeof RACE_DETAIL] | null;
}) {
  const racePenaltyLabel = detail ? detail.penaltyLabel : "Race-mechanic penalty";
  const rows: { label: string; value: string; tone?: string }[] = [];
  if (typeof raw.sq === "number")
    rows.push({ label: "Spending Quotient (SQ)", value: raw.sq.toFixed(1) });
  if (typeof raw.base_score === "number")
    rows.push({ label: "Base score (SQ - 5)", value: raw.base_score.toFixed(1) });
  rows.push({
    label: "Supply-block penalty",
    value: `-${Number(raw.supply_block_penalty || 0).toFixed(1)}`,
    tone: (raw.supply_block_penalty || 0) > 0 ? "text-danger" : "text-success",
  });
  rows.push({
    label: racePenaltyLabel,
    value: `-${Number(raw.race_penalty || 0).toFixed(1)}`,
    tone: (raw.race_penalty || 0) > 0 ? "text-danger" : "text-success",
  });
  rows.push({
    label: "Mineral-float penalty",
    value: `-${Number(raw.float_penalty || 0).toFixed(1)}`,
    tone: (raw.float_penalty || 0) > 0 ? "text-danger" : "text-success",
  });

  return (
    <section className="rounded-lg border border-border bg-bg-elevated/40 p-4">
      <h3 className="mb-2 text-caption font-semibold uppercase tracking-wider text-text-muted">
        How this number was calculated
      </h3>
      <p className="mb-3 text-caption text-text-muted">
        Headline = Spending Quotient (SQ) − 5, then small penalties for the
        SC2-specific macro disciplines (clamped 0..100).
      </p>
      <table className="w-full text-caption">
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="py-1 text-text">{r.label}</td>
              <td
                className={`py-1 text-right tabular-nums ${r.tone || "text-text"}`}
              >
                {r.value}
              </td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="py-1 text-text">Final score (clamped)</td>
            <td className={`py-1 text-right tabular-nums ${headlineColour}`}>
              {typeof score === "number" ? score : "—"}
            </td>
          </tr>
        </tbody>
      </table>

      {detail &&
      raw[detail.actualKey] != null &&
      raw[detail.expectedKey] != null ? (
        <div className="mt-3 rounded-md bg-bg-subtle p-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-text-dim">
            {detail.title}
          </div>
          <div className="text-caption text-accent">
            {String(raw[detail.actualKey])} of ~
            {String(raw[detail.expectedKey])} expected (
            {Math.round(
              (100 * Number(raw[detail.actualKey] || 0)) /
                Math.max(1, Number(raw[detail.expectedKey] || 1)),
            )}
            % {detail.unitPlural})
          </div>
        </div>
      ) : null}
    </section>
  );
}

function WinsAndLeaksPanel({
  wins,
  leaks,
}: {
  wins: string[];
  leaks: Leak[];
}) {
  return (
    <section className="rounded-lg border border-border bg-bg-elevated/40 p-4 space-y-4">
      {wins.length > 0 ? (
        <div>
          <h3 className="mb-1 text-caption font-semibold uppercase tracking-wider text-success">
            What you did well
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-caption text-text">
            {wins.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <h3 className="mb-1 text-caption font-semibold uppercase tracking-wider text-danger">
          Where you lost economy
        </h3>
        {leaks.length === 0 ? (
          <p className="text-caption text-text-muted">
            No notable leaks detected.
          </p>
        ) : (
          <ul className="space-y-2">
            {leaks.map((lk, i) => (
              <li
                key={`${lk.name || "leak"}-${i}`}
                className="rounded-md bg-bg-subtle p-2"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-caption font-semibold text-text">
                    {lk.name || "Unnamed leak"}
                  </span>
                  {typeof lk.penalty === "number" && lk.penalty > 0 ? (
                    <span className="ml-auto text-[11px] font-semibold tabular-nums text-danger">
                      -{lk.penalty.toFixed(1)} pts
                    </span>
                  ) : null}
                </div>
                {lk.detail ? (
                  <div className="mt-0.5 text-[11px] text-text-muted">
                    {lk.detail}
                  </div>
                ) : null}
                {typeof lk.mineral_cost === "number" && lk.mineral_cost > 0 ? (
                  <div className="mt-0.5 text-[11px] text-warning">
                    ~{lk.mineral_cost} min lost
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function DisciplineMetricsPanel({
  raw,
  detail,
}: {
  raw: BreakdownRaw;
  detail: (typeof RACE_DETAIL)[keyof typeof RACE_DETAIL] | null;
}) {
  const hasSupply = raw.supply_blocked_seconds != null;
  const hasFloat = raw.mineral_float_spikes != null;
  if (!hasSupply && !hasFloat && !detail) return null;
  return (
    <section className="rounded-lg border border-border bg-bg-elevated/40 p-4">
      <h3 className="mb-2 text-caption font-semibold uppercase tracking-wider text-text-muted">
        Discipline metrics
      </h3>
      <ul className="space-y-1 text-caption text-text">
        {hasSupply ? (
          <li>
            Supply-blocked:{" "}
            <span className="tabular-nums text-accent">
              {Math.round(raw.supply_blocked_seconds || 0)}s total
            </span>
          </li>
        ) : null}
        {hasFloat ? (
          <li>
            Mineral float spikes (&gt;800 after 4:00):{" "}
            <span className="tabular-nums text-accent">
              {raw.mineral_float_spikes} sample(s)
            </span>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function ErrorPanel({
  status,
  message,
  onRecompute,
  recomputing,
}: {
  status: number;
  message: string;
  onRecompute: () => void;
  recomputing: boolean;
}) {
  if (status === 404) {
    return (
      <div className="rounded-lg border border-border bg-bg-elevated/40 p-4 text-caption text-text-muted">
        <p className="mb-3">
          No macro detail stored for this game yet. Click{" "}
          <span className="font-semibold text-text">Recompute</span> below to
          ask your SC2 agent to re-parse the replay file.
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={onRecompute}
          loading={recomputing}
        >
          {recomputing ? "Recomputing…" : "Recompute now"}
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-danger/40 bg-bg-elevated/40 p-4 text-caption text-danger">
      Macro unavailable: {message}
    </div>
  );
}
