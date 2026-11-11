"use client";

import { Toggle } from "@/components/ui/Toggle";
import { InstantBadge } from "@/components/ui/InstantBadge";
import { OVERLAY_CREDIT_TEXT } from "@/lib/overlayCredit";

/**
 * The "show the sc2tools.com credit on stream" switch under the all-in-one
 * overlay URL. An Instant control: the choice saves to this overlay's
 * profile right away and follows the account to any browser. The URLs
 * Settings hands out carry it (``credit=0``), so a streamer who switches
 * it off pastes the new URL into OBS once.
 *
 * Example:
 *   const { credit, setCredit, busy } = useOverlayFlags();
 *   <OverlayCreditToggle checked={credit} onChange={setCredit} disabled={busy} />
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
    <div className="flex items-start gap-2 text-caption text-text-dim">
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={`Show “${OVERLAY_CREDIT_TEXT}” on stream`} />
      <span>
        <InstantBadge className="mr-1.5 align-middle" />
        Show a small “{OVERLAY_CREDIT_TEXT}” credit (top-left while widgets
        are on screen, and on the Starting Soon / BRB scenes). It helps other
        players find the tool. Saved to your account; after switching it
        off, copy your URLs into OBS again.
      </span>
    </div>
  );
}
