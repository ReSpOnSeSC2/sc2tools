"use client";

import { Modal } from "@/components/ui/Modal";
import { REPLAY_SHORTCUTS } from "@/lib/replayControls";

export function ReplayShortcutSheet({ open, onClose, container }: { open: boolean; onClose: () => void; container?: Element | null }) {
  return <Modal portalContainer={container} open={open} onClose={onClose} title="Replay keyboard shortcuts" description="Click the replay map to focus the player. Shortcuts leave text fields and other controls alone.">
    <table className="w-full text-left text-body-sm"><thead><tr><th className="p-2">Key</th><th className="p-2">Action</th></tr></thead><tbody>{REPLAY_SHORTCUTS.map(([key, action]) => <tr key={key} className="border-t border-border"><td className="whitespace-nowrap p-2 font-semibold">{key}</td><td className="p-2">{action}</td></tr>)}</tbody></table>
  </Modal>;
}
