"use client";

import { useId, type ComponentType, type SVGProps } from "react";
import { Bug, CircleHelp, Lightbulb } from "lucide-react";
import type { ReportType } from "@/lib/feedback/reportContext";

const OPTIONS: ReadonlyArray<{ id: ReportType; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }> = [
  { id: "problem", label: "Problem", Icon: Bug },
  { id: "idea", label: "Idea", Icon: Lightbulb },
  { id: "question", label: "Question", Icon: CircleHelp },
];

/**
 * Problem | Idea | Question segmented control. Native radio buttons
 * under the hood, so arrow keys move between the options and screen
 * readers announce "Problem, radio button, 1 of 3".
 */
export function ReportTypePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: ReportType;
  onChange: (next: ReportType) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-1.5 text-caption font-medium text-text">What is it?</legend>
      <div className="grid grid-cols-3 overflow-hidden rounded-lg border-2 border-line">
        {OPTIONS.map(({ id, label, Icon }, index) => {
          const selected = value === id;
          return (
            <label
              key={id}
              className={[
                "relative flex min-h-11 cursor-pointer items-center justify-center gap-1.5 px-2 text-caption font-semibold transition-colors",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-accent",
                index > 0 ? "border-l-2 border-line" : "",
                selected ? "bg-accent/15 text-accent" : "text-text-muted hover:bg-bg-elevated hover:text-text",
              ].join(" ")}
            >
              <input
                type="radio"
                name={name}
                value={id}
                checked={selected}
                onChange={() => onChange(id)}
                className="sr-only"
              />
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
