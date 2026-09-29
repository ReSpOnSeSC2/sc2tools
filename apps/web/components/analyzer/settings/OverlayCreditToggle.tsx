"use client";

import { Toggle } from "@/components/ui/Toggle";
import { OVERLAY_CREDIT_TEXT } from "@/lib/overlayCredit";

/**
 * The "show the sc2tools.com credit on stream" switch under the all-in-one
 * overlay URL. The choice lives in the URLs Settings hands out
 * (``credit=0``), so a streamer who switches it off has to paste the new
 * URL into OBS.
 *
 * Example:
 *   const [showCredit, setShowCredit] = useOverlayCreditPreference();
 *   <OverlayCreditToggle checked={showCredit} onChange={setShowCredit} />
 */
export function OverlayCreditToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (show: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-caption text-text-dim">
      <Toggle checked={checked} onChange={onChange} label={`Show “${OVERLAY_CREDIT_TEXT}” on stream`} />
      <span>
        Show a small “{OVERLAY_CREDIT_TEXT}” credit (top-left while widgets
        are on screen, and on the Starting Soon / BRB scenes). It helps other
        players find the tool. After switching it off, copy your URLs into
        OBS again.
      </span>
    </label>
  );
}
