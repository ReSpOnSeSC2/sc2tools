"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { TABS, type TabDef, type TabId } from "./tabs";

export function MobileSectionPicker({
  value,
  onChange,
  active,
}: {
  value: TabId;
  onChange: (next: string) => void;
  active: TabDef;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) setOpen(false);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="sm:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-lg border border-border bg-bg-surface px-3 py-2 text-left transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <span className="inline-flex items-center gap-2 text-body font-medium text-text">
          <active.icon
            className="h-4 w-4 flex-shrink-0 text-accent-cyan"
            aria-hidden
          />
          {active.label}
        </span>
        <ChevronDown
          className="h-4 w-4 flex-shrink-0 text-text-muted"
          aria-hidden
        />
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Dashboard sections"
        description="Pick a section to drill into."
        size="sm"
      >
        <ul className="-mx-2 flex flex-col gap-0.5">
          {TABS.map(({ id, label, icon: Icon, description }) => {
            const selected = id === value;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => onChange(id)}
                  aria-pressed={selected}
                  className={[
                    "flex min-h-[44px] w-full items-start gap-2 rounded-md px-3 py-2 text-left",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                    selected
                      ? "bg-accent/15 text-accent"
                      : "text-text-muted hover:bg-bg-elevated hover:text-text",
                  ].join(" ")}
                >
                  <Icon
                    className={[
                      "mt-0.5 h-4 w-4 flex-shrink-0",
                      selected ? "text-accent" : "text-accent-cyan",
                    ].join(" ")}
                    aria-hidden
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-body font-medium">{label}</span>
                    {description ? (
                      <span className="text-caption text-text-dim">
                        {description}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Modal>
    </div>
  );
}
