"use client";

import { Toggle } from "@/components/ui/Toggle";
import { InstantBadge } from "@/components/ui/InstantBadge";
import { OVERLAY_CREDIT_TEXT } from "@/lib/overlayCredit";

/**
 * Saves the credit preference on this overlay token and updates its
 * connected Browser Sources.
 */
export function OverlayCreditToggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (show: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-caption text-text-dim">
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={`Show “${OVERLAY_CREDIT_TEXT}” on stream`} />
      <span>
        <InstantBadge className="mr-1.5 align-middle" />
        Show a small “{OVERLAY_CREDIT_TEXT}” credit with All-in-one widgets
        and on full-screen scenes. Changes apply to connected Browser Sources.
        URLs with <code>credit=0</code> always hide the credit.
      </span>
    </label>
  );
}
