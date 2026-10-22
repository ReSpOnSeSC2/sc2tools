"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * SegmentedControl — pick exactly one of a few options, laid out as a
 * row of pills (All · vs P · vs T · vs Z).
 *
 * A radio group to assistive tech: one Tab stop, the checked option
 * focused first; Arrow keys (and Home/End) move between options and pick
 * the one they land on, as native radio buttons do. Targets are 44px
 * tall on phones and 32px from `sm` up, where the pointer is precise.
 *
 * Use it for a short, mutually exclusive choice that applies at once.
 * For on/off use Toggle; for a long list use Select.
 */
export interface SegmentedOption<T extends string> {
  value: T;
  /** Visible text. Keep it short; the row must fit at 390px. */
  label: ReactNode;
  /** Spoken name when the visible label is an abbreviation ("vs P"). */
  ariaLabel?: string;
  /** Tooltip on pointer devices. */
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group. */
  label?: string;
  /** Id of a visible element that names the group (preferred over `label`). */
  labelledBy?: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (next: T) => void;
  className?: string;
}

export function SegmentedControl<T extends string>({
  label,
  labelledBy,
  value,
  options,
  onChange,
  className = "",
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedIndex = options.findIndex((o) => o.value === value);
  // With no match the first option keeps the group reachable by Tab.
  const tabStop = checkedIndex >= 0 ? checkedIndex : 0;

  const move = (to: number) => {
    const count = options.length;
    const index = ((to % count) + count) % count;
    refs.current[index]?.focus();
    if (options[index].value !== value) onChange(options[index].value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(index - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(options.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className={[
        "inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-full border-2 border-line bg-bg-surface p-0.5",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {options.map((option, index) => {
        const checked = index === checkedIndex;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.ariaLabel}
            title={option.title}
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={[
              "inline-flex min-h-11 min-w-11 items-center justify-center rounded-full px-3 sm:min-h-8",
              "text-caption font-semibold tabular-nums transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              checked
                ? "bg-accent text-white"
                : "text-text-muted hover:bg-bg-elevated hover:text-text",
            ].join(" ")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
