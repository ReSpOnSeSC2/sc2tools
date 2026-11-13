"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SkeletonBar, SkeletonRegion } from "@/components/ui/Skeleton";
import { useReplayAccept } from "@/components/instant/useReplayAccept";
import { seatLabel, type RoomAction, type Seat } from "@/lib/matchRoom";
import type { ReplayOutcome } from "@/lib/matchRoomReplay";
import { useRoomReplay } from "./useRoomReplay";

function ReplayOutcomes({ disabled, report }: { disabled: boolean; report: (outcome: ReplayOutcome) => void }) {
  return <div className="space-y-3">
    <p className="text-body text-text-muted">Choose your result to report it to the room.</p>
    <div className="grid gap-2">
      <Button variant="secondary" fullWidth aria-disabled={disabled} className="aria-disabled:opacity-50"
        onClick={() => { if (!disabled) report("Win"); }}>I won</Button>
      <Button variant="secondary" fullWidth aria-disabled={disabled} className="aria-disabled:opacity-50"
        onClick={() => { if (!disabled) report("Loss"); }}>I lost</Button>
    </div>
  </div>;
}

function useReportInput() {
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const accept = useReplayAccept();
  return { input, trigger, accept, choose: () => input.current?.click() };
}

export type ReplayReportFeedback = { actionError: string; connectionError: string; reconnect: () => void };

export function ReplayReportControl({ roomId, seat, blocked, send, feedback }: {
  roomId: string; seat: Seat; blocked: boolean; send: (action: RoomAction) => Promise<boolean>;
  feedback: ReplayReportFeedback;
}) {
  const { input, trigger, accept, choose } = useReportInput();
  const { state, sending, read, report, close } = useRoomReplay({ roomId, seat, send });
  return <>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-line p-2"
      onDragOver={event => { event.preventDefault(); }}
      onDrop={event => { event.preventDefault(); if (!blocked) void read(event.dataTransfer.files); }}>
      <Button ref={trigger} variant="secondary" disabled={blocked} onClick={choose}>Choose replay</Button>
      <span className="text-caption text-text-muted">Or drop one replay here. The file stays on this device.</span>
      <input ref={input} type="file" hidden aria-label="Match replay" accept={accept ? ".SC2Replay" : undefined}
        onChange={event => { void read(event.currentTarget.files); event.currentTarget.value = ""; }} />
    </div>
    <Modal open={state.kind !== "idle"} onClose={close} title={"Report replay as " + seatLabel(seat)}
      description="The room receives the winner, map, timing and room-specific fingerprints when you report. Player names stay on this device."
      returnFocusRef={trigger} size="sm">
      {state.kind === "reading" && <SkeletonRegion label="Reading replay" className="space-y-2">
        <p className="text-body text-text">Reading replay on this device…</p>
        <SkeletonBar className="h-11 w-full" />
        <SkeletonBar className="h-11 w-full" />
      </SkeletonRegion>}
      {state.kind === "ready" && <>
        <ReplayOutcomes disabled={blocked || sending} report={outcome => { void report(outcome); }} />
        {state.failed && <p role="alert" className="text-body text-danger">
          {feedback.actionError || "The report could not be saved. Try reporting again."}
        </p>}
      </>}
      {feedback.connectionError && <div className="space-y-2">
        <p role="alert" className="text-body text-danger">{feedback.connectionError}</p>
        <Button variant="secondary" onClick={feedback.reconnect}>Retry connection</Button>
      </div>}
      {sending && <p role="status" className="text-caption text-text-muted">Sending report…</p>}
      {state.kind === "error" && <div className="space-y-3">
        <p role="alert" className="text-body text-danger">{state.message}</p>
        <Button variant="secondary" disabled={blocked} onClick={choose}>Choose another replay</Button>
      </div>}
    </Modal>
  </>;
}
