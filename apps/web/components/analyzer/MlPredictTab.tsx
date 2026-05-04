"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import { Card, EmptyState } from "@/components/ui/Card";
import { pct1 } from "@/lib/format";

type Prediction = {
  label: string;
  probability: number;
  rank: number;
};

type PredictResp = {
  predictions: Prediction[];
  modelVersion?: string;
  warnings?: string[];
};

export function MlPredictTab() {
  const { getToken } = useAuth();
  const [oppName, setOppName] = useState("");
  const [oppRace, setOppRace] = useState("Z");
  const [map, setMap] = useState("");
  const [oppMmr, setOppMmr] = useState<number | "">("");
  const [resp, setResp] = useState<PredictResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function predict() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiCall<PredictResp>(getToken, "/v1/ml/pregame", {
        method: "POST",
        body: JSON.stringify({
          opponent: oppName,
          oppRace,
          map,
          oppMmr: oppMmr === "" ? undefined : Number(oppMmr),
        }),
      });
      setResp(r);
    } catch (e) {
      const err = e as { message?: string };
      setError(err?.message || "Prediction failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="Pre-game prediction">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Opponent name"
            value={oppName}
            onChange={setOppName}
          />
          <Field
            label="Opponent race"
            value={oppRace}
            onChange={setOppRace}
            options={[
              ["T", "Terran"],
              ["P", "Protoss"],
              ["Z", "Zerg"],
              ["R", "Random"],
            ]}
          />
          <Field label="Map" value={map} onChange={setMap} />
          <Field
            label="Opponent MMR"
            value={oppMmr === "" ? "" : String(oppMmr)}
            onChange={(v) => setOppMmr(v === "" ? "" : Number(v))}
            type="number"
          />
        </div>
        <div className="mt-3 flex justify-end">
          <button type="button" className="btn" onClick={predict} disabled={busy}>
            {busy ? "Predicting…" : "Predict"}
          </button>
        </div>
        {error && (
          <p className="mt-2 text-sm text-danger">{error}</p>
        )}
      </Card>

      {resp && (
        <Card
          title={`Predictions ${resp.modelVersion ? `· ${resp.modelVersion}` : ""}`}
        >
          {resp.predictions.length === 0 ? (
            <EmptyState title="No predictions returned" />
          ) : (
            <ul className="space-y-2 text-sm">
              {resp.predictions.map((p) => (
                <li key={p.label} className="flex items-center gap-3">
                  <span className="w-7 text-right text-text-dim">{p.rank}.</span>
                  <span className="w-48 truncate">{p.label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded bg-bg-elevated">
                    <div
                      className="h-full bg-accent"
                      style={{ width: `${p.probability * 100}%` }}
                    />
                  </div>
                  <span className="w-12 text-right tabular-nums">
                    {pct1(p.probability)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {resp.warnings && resp.warnings.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-warning">
              {resp.warnings.map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  options,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options?: [string, string][];
  type?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="block text-xs uppercase tracking-wider text-text-dim">
        {label}
      </span>
      {options ? (
        <select
          className="input mt-1 py-1.5 text-sm"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map(([v, lbl]) => (
            <option key={v} value={v}>
              {lbl}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={type}
          className="input mt-1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
