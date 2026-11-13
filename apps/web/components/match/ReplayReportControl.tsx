"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SkeletonBar, SkeletonRegion } from "@/components/ui/Skeleton";
import { useReplayAccept } from "@/components/instant/useReplayAccept";
import { seatLabel, type RoomAction, type Seat } from "@/lib/matchRoom";
import type { MatchReplay } from "@/lib/matchRoomReplay";
import { useRoomReplay } from "./useRoomReplay";

function ReplayPlayers({ replay, disabled, report }: { replay: MatchReplay; disabled: boolean; report: (index: 0 | 1) => void }) {
  return <div className="space-y-3">
    <p className="text-body text-text-muted">Select your name to report the result to the room.</p>
    <div className="grid gap-2">
      {([0, 1] as const).map(index => {
        const player = replay.players[index];
        return <Button key={player.pid} variant="secondary" fullWidth disabled={disabled}
          className="h-auto min-h-11 justify-start whitespace-normal break-words py-2 text-left" onClick={() => report(index)}>
          {player.name || "Player " + (index + 1)} ({player.result === "Win" ? "winner" : "runner-up"})
        </Button>;
      })}
    </div>
  </div>;
}

function useReportInput() {
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const accept = useReplayAccept();
  return { input, trigger, accept, choose: () => input.current?.click() };
}

export function ReplayReportControl({ roomId, seat, blocked, send }: {
  roomId: string; seat: Seat; blocked: boolean; send: (action: RoomAction) => Promise<boolean>;
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
      {state.kind === "ready" && <ReplayPlayers replay={state.replay} disabled={blocked || sending}
        report={index => { void report(index); }} />}
      {sending && <p role="status" className="text-caption text-text-muted">Sending report…</p>}
      {state.kind === "error" && <div className="space-y-3">
        <p role="alert" className="text-body text-danger">{state.message}</p>
        <Button variant="secondary" disabled={blocked} onClick={choose}>Choose another replay</Button>
      </div>}
    </Modal>
  </>;
}
