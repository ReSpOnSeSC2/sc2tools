"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";

const STEPS = [
  { id: "foundation", label: "Foundation" },
  { id: "early", label: "Account" },
  { id: "integrations", label: "Integrations" },
  { id: "streamlabs", label: "Donations" },
  { id: "apply-import", label: "Import history" },
] as const;

export type WizardStepId = (typeof STEPS)[number]["id"];

export function WizardShell({
  initial = "foundation",
  renderStep,
  onClose,
}: {
  initial?: WizardStepId;
  renderStep: (id: WizardStepId, helpers: WizardHelpers) => ReactNode;
  onClose?: () => void;
}) {
  const [active, setActive] = useState<WizardStepId>(initial);
  const idx = STEPS.findIndex((s) => s.id === active);

  const helpers: WizardHelpers = {
    next: () => {
      const ni = Math.min(STEPS.length - 1, idx + 1);
      setActive(STEPS[ni].id);
    },
    prev: () => {
      const pi = Math.max(0, idx - 1);
      setActive(STEPS[pi].id);
    },
    isLast: idx === STEPS.length - 1,
    isFirst: idx === 0,
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Welcome to SC2 Tools</h1>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary text-xs"
          >
            Skip wizard
          </button>
        )}
      </div>

      <ol className="flex flex-wrap items-center gap-2 text-xs text-text-dim">
        {STEPS.map((s, i) => (
          <li
            key={s.id}
            className={`flex items-center gap-2 rounded px-2 py-1 ${
              i === idx
                ? "bg-accent/15 text-accent"
                : i < idx
                  ? "text-success"
                  : ""
            }`}
          >
            <span className="font-mono">{i + 1}.</span> {s.label}
            {i < STEPS.length - 1 && <span className="text-text-dim">→</span>}
          </li>
        ))}
      </ol>

      <div className="card p-5">{renderStep(active, helpers)}</div>

      <div className="flex justify-between">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={helpers.prev}
          disabled={helpers.isFirst}
        >
          ← Back
        </button>
        {helpers.isLast ? (
          <Link href="/app" className="btn">
            Go to analyzer →
          </Link>
        ) : (
          <button type="button" className="btn" onClick={helpers.next}>
            Continue →
          </button>
        )}
      </div>
    </div>
  );
}

export type WizardHelpers = {
  next: () => void;
  prev: () => void;
  isLast: boolean;
  isFirst: boolean;
};
