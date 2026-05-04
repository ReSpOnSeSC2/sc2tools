"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { Card, EmptyState, Skeleton, Stat } from "@/components/ui/Card";
import { fmtAgo, pct1 } from "@/lib/format";

type MlStatus = {
  hasModel: boolean;
  trainedAt?: string | null;
  metrics?: {
    accuracy?: number;
    f1?: number;
    samples?: number;
  };
  jobs?: { id: string; status: string; startedAt: string; finishedAt?: string }[];
  options?: {
    targets: string[];
    horizons: string[];
    algorithms: string[];
  };
};

const TARGETS = ["win", "opp_strategy", "matchup_outcome"];

export function MlCoreTab() {
  const { getToken } = useAuth();
  const status = useApi<MlStatus>("/v1/ml/status");
  const [target, setTarget] = useState("win");
  const [horizon, setHorizon] = useState("session");
  const [algo, setAlgo] = useState("logistic_regression");
  const [busy, setBusy] = useState(false);

  async function train() {
    if (busy) return;
    setBusy(true);
    try {
      await apiCall(getToken, "/v1/ml/train", {
        method: "POST",
        body: JSON.stringify({ target, horizon, algorithm: algo }),
      });
      await status.mutate();
    } finally {
      setBusy(false);
    }
  }

  if (status.isLoading) return <Skeleton rows={4} />;
  const s = status.data;

  return (
    <div className="space-y-4">
      <Card title="Train a model">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Picker label="Target" value={target} onChange={setTarget} options={s?.options?.targets || TARGETS} />
          <Picker
            label="Horizon"
            value={horizon}
            onChange={setHorizon}
            options={s?.options?.horizons || ["session", "week", "month"]}
          />
          <Picker
            label="Algorithm"
            value={algo}
            onChange={setAlgo}
            options={
              s?.options?.algorithms || [
                "logistic_regression",
                "random_forest",
                "gradient_boosting",
              ]
            }
          />
        </div>
        <div className="mt-3 flex justify-end">
          <button type="button" className="btn" onClick={train} disabled={busy}>
            {busy ? "Training…" : "Train"}
          </button>
        </div>
        <p className="mt-2 text-xs text-text-muted">
          Train runs server-side via <code>scripts/ml_cli.py</code>. Takes
          15&ndash;120s depending on game count.
        </p>
      </Card>

      {!s?.hasModel ? (
        <Card>
          <EmptyState title="No model trained yet" />
        </Card>
      ) : (
        <Card title="Current model">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="Trained"
              value={s.trainedAt ? fmtAgo(s.trainedAt) : "—"}
            />
            <Stat
              label="Samples"
              value={s.metrics?.samples ?? "—"}
            />
            <Stat
              label="Accuracy"
              value={pct1(s.metrics?.accuracy)}
              color="#3ec07a"
            />
            <Stat
              label="F1"
              value={pct1(s.metrics?.f1)}
              color="#7c8cff"
            />
          </div>
        </Card>
      )}

      {s?.jobs && s.jobs.length > 0 && (
        <Card title="Training jobs">
          <ul className="divide-y divide-border text-sm">
            {s.jobs.slice(0, 8).map((j) => (
              <li
                key={j.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span>
                  <span className="font-mono text-xs">{j.id}</span>
                  <span className="ml-2 rounded bg-bg-elevated px-1.5 py-0.5 text-[10px]">
                    {j.status}
                  </span>
                </span>
                <span className="text-xs text-text-dim">
                  {j.finishedAt
                    ? fmtAgo(j.finishedAt)
                    : `started ${fmtAgo(j.startedAt)}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Picker({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="block text-sm">
      <span className="block text-xs uppercase tracking-wider text-text-dim">
        {label}
      </span>
      <select
        className="input mt-1 py-1.5 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
