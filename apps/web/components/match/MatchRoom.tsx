"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import { SkeletonBar, SkeletonRegion } from "@/components/ui/Skeleton";
import { useConfirm } from "@/components/ui/useConfirm";
import { parseRoomInvite, seatLabel, type RoomAction, type RoomInvite } from "@/lib/matchRoom";
import { RoomSeats, ScoreBoard, VetoBoard } from "./MatchBoard";
import { InviteLinks, MatchResultExport } from "./RoomShares";
import { useMatchRoom } from "./useMatchRoom";

function subscribe(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function LoadingRoom() {
  return <SkeletonRegion label="Loading match room" className="space-y-4">
    <div className="flex min-h-6 items-center"><SkeletonBar className="h-4 w-28" /></div>
    <div className="grid gap-3 sm:grid-cols-2">
      {[0, 1].map(seat => <div key={seat} className="space-y-3 rounded-xl border border-line bg-bg-surface p-4">
        <SkeletonBar className="h-6 w-24" /><SkeletonBar className="h-4 w-36" />
      </div>)}
    </div>
    <div className="space-y-3 rounded-xl border border-line bg-bg-surface p-4">
      <SkeletonBar className="h-6 w-28" />
      <div className="grid gap-2 sm:grid-cols-2">
        {[0, 1, 2, 3].map(map => <SkeletonBar key={map} className="h-11 w-full" />)}
      </div>
    </div>
  </SkeletonRegion>;
}

function MissingRoom({ invite }: { invite: boolean }) {
  return <section className="space-y-3 rounded-xl border border-line bg-bg-surface p-4">
    <h2 className="font-display text-h3 font-bold text-text">{invite ? "Room unavailable" : "Open a room link"}</h2>
    <p className="text-body text-text-muted">
      {invite ? "This room may have expired or been deleted." : "Ask the host for a seat or watch link, or create a room."}
    </p>
    <Link href="/match" className="inline-flex min-h-11 items-center text-body font-semibold text-accent underline focus-visible:ring-2 focus-visible:ring-accent">
      Create a match room
    </Link>
  </section>;
}

function ActiveRoom({ invite, session, frame }: {
  invite: RoomInvite;
  session: ReturnType<typeof useMatchRoom>;
  frame: NonNullable<ReturnType<typeof useMatchRoom>["frame"]>;
}) {
  const { reading, actionError, busy } = session;
  const { room, receivedAt } = frame;
  const { confirm, dialog } = useConfirm();
  async function removeRoom() {
    if (await confirm({ title: "Delete this room?", description: "The seat and watch links will stop working immediately.",
      confirmLabel: "Delete room", intent: "danger", focusCancel: true })) await session.mutate("delete", room.rev);
  }
  async function send(action: RoomAction) {
    const saved = await session.mutate(action, room.rev);
    if (saved && action.type !== "name" && action.type !== "ready") {
      window.requestAnimationFrame(() => {
        const title = document.getElementById("match-score-title") ?? document.getElementById("match-veto-title");
        title?.focus();
      });
    }
    return saved;
  }
  const role = invite.role;
  const host = role === "host";
  const blocked = busy || Boolean(reading.error);
  return (
    <>
      <p className="text-body text-text-muted">
        Best of {room.config.format} · {room.config.practice ? "Practice" : roleLabel(role)}
      </p>
      {actionError && <p role="alert" className="rounded-lg border border-line p-3 text-body text-danger">{actionError}</p>}
      <RoomSeats room={room} role={role} blocked={blocked} send={send} />
      <VetoBoard room={room} role={role} blocked={blocked} send={send} receivedAt={receivedAt} />
      <ScoreBoard room={room} role={role} blocked={blocked} send={send} />
      {room.phase === "complete" && <MatchResultExport room={room} />}
      {invite.role === "host" && !room.config.practice && <InviteLinks invite={invite} />}
      {host && <Button variant="danger" disabled={busy} onClick={() => { void removeRoom(); }}>Delete room now</Button>}
      {dialog}
    </>
  );
}

function RoomConnection({ invite }: { invite: RoomInvite }) {
  const session = useMatchRoom(invite);
  const { frame, reading } = session;
  if (reading.gone) return <MissingRoom invite />;
  return (
    <>
      {reading.error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-bg-surface p-4">
        <p className="text-body text-text">{reading.error}</p>
        <Button variant="secondary" onClick={session.retry}>Retry connection</Button>
      </div>}
      {frame ? <ActiveRoom invite={invite} session={session} frame={frame} /> : !reading.error && <LoadingRoom />}
    </>
  );
}

function roleLabel(role: RoomInvite["role"]) {
  if (role === "host") return "Host";
  if (role === "watch") return "Watching";
  return seatLabel(role);
}

export function MatchRoom() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => null);
  const invite = hash ? parseRoomInvite(hash) : null;
  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-8">
      <h1 className="font-display text-display-lg font-bold text-text">Match Room</h1>
      {hash === null ? <LoadingRoom /> : invite ? <RoomConnection key={hash} invite={invite} /> : <MissingRoom invite={false} />}
    </div>
  );
}
