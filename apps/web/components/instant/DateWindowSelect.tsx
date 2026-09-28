"use client";

/**
 * DateWindowSelect — "Last 90 days" (default) | "All time" segmented
 * control for an Instant Analysis import. A native radio group inside a
 * fieldset, so arrow keys, labels and screen readers work without ARIA
 * plumbing; each option is a 44px touch target.
 *
 * Example:
 *   <DateWindowSelect value={session.dateWindow} onChange={session.setDateWindow} disabled={session.busy} />
 */
import { useId } from "react";
import { dateWindowLabel, type DateWindow } from "@/lib/instant/fileIntake";

const OPTIONS: ReadonlyArray<DateWindow> = [{ kind: "days90" }, { kind: "all" }];

export interface DateWindowSelectProps {
  value: DateWindow;
  onChange: (window: DateWindow) => void;
  disabled?: boolean;
  /** Visible group label. */
  legend?: string;
  className?: string;
}

/**
 * Two-option date window picker.
 *
 * Example:
 *   <DateWindowSelect value={{ kind: "days90" }} onChange={setWindow} />
 */
export function DateWindowSelect({
  value,
  onChange,
  disabled = false,
  legend = "Replays from",
  className = "",
}: DateWindowSelectProps) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className={["min-w-0", className].filter(Boolean).join(" ")}>
      <legend className="mb-1 text-caption font-semibold text-text">{legend}</legend>
      <div className="inline-flex flex-wrap gap-1 rounded-full border-2 border-line bg-bg-surface p-1">
        {OPTIONS.map((option) => (
          <label key={option.kind} className="relative inline-flex cursor-pointer has-[:disabled]:cursor-not-allowed">
            <input
              type="radio"
              name={name}
              value={option.kind}
              checked={option.kind === value.kind}
              onChange={() => onChange(option)}
              className="peer sr-only"
            />
            <span
              className={[
                "inline-flex min-h-[44px] items-center rounded-full px-4 text-caption font-semibold",
                "text-text-muted transition-colors motion-reduce:transition-none",
                "hover:text-text peer-checked:bg-accent peer-checked:text-white",
                "peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg",
                "peer-disabled:opacity-50",
              ].join(" ")}
            >
              {dateWindowLabel(option)}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
