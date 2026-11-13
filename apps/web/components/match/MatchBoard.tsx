"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SEATS, seatLabel, type Role, type Room, type RoomAction, type Seat } from "@/lib/matchRoom";
import { ReplayReportControl, type ReplayReportFeedback } from "./ReplayReportControl";
import { useVetoCountdown } from "./useVetoCountdown";

type Send = (action: RoomAction) => Promise<boolean>;
type BoardProps = { room: Room; role: Role; blocked: boolean; send: Send };
const BOARD = "space-y-3 rounded-xl border border-line bg-bg-surface p-4";
const HEADING = "font-display text-h3 font-bold text-text";
const FOCUS_HEADING = HEADING + " rounded focus-visible:ring-2 focus-visible:ring-accent";

function canPlay(room: Room, role: Role, seat: Seat) {
  return role === seat || (role === "host" && room.config.practice);
}

function SeatName({ room, seat, blocked, send }: { room: Room; seat: Seat; blocked: boolean; send: Send }) {
  const [name, setName] = useState(room.names[seat]);
  const label = seatLabel(seat);
  return (
    <form action="/match/room" className="flex min-w-0 flex-wrap items-end gap-2"
      onSubmit={event => { event.preventDefault(); void send({ type: "name", as: seat, value: name }); }}>
      <label className="min-w-28 flex-1 space-y-1 text-caption text-text-muted">
        {label} name
        <Input inputSize="lg" maxLength={24} value={name} disabled={blocked} onChange={event => setName(event.target.value)} />
      </label>
      <Button type="submit" variant="secondary" disabled={blocked || name === room.names[seat]}>Save name</Button>
    </form>
  );
}

export function RoomSeats({ room, role, blocked, send }: BoardProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="Series seats">
      {SEATS.map(seat => <section key={seat} className={BOARD} aria-label={seatLabel(seat)}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <h2 className={HEADING}>{seatLabel(seat)}{role === seat ? " · You" : ""}</h2>
            {room.names[seat] && <p className="break-words text-body text-text">{room.names[seat]} <span className="text-caption text-text-muted">(self-declared)</span></p>}
            {room.phase === "lobby" && <p className="text-caption text-text-muted">{room.ready[seat] ? "Ready" : "Waiting for player"}</p>}
          </div>
          <p className="font-display text-h1 font-bold tabular-nums text-text">
            {room.score[seat]}<span className="sr-only"> wins</span>
          </p>
        </div>
        {canPlay(room, role, seat) && room.phase === "lobby" && <>
          <SeatName key={room.names[seat]} room={room} seat={seat} blocked={blocked} send={send} />
          <Button variant={room.ready[seat] ? "secondary" : "primary"} disabled={blocked}
            onClick={() => { void send({ type: "ready", as: seat, value: !room.ready[seat] }); }}>
            {room.ready[seat] ? "Unready " : "Ready "}{seatLabel(seat)}
          </Button>
        </>}
      </section>)}
    </div>
  );
}

export function VetoBoard({ room, role, blocked, send, receivedAt }: BoardProps & { receivedAt: number }) {
  const { turn, deadline } = room;
  const remaining = useVetoCountdown(deadline, room.serverTime, receivedAt);
  const byMap = new Map(room.moves.map(move => [move.map, move]));
  const canVeto = turn !== null && remaining !== 0 && canPlay(room, role, turn.seat);
  if (room.phase === "play" || room.phase === "complete") return null;
  return (
    <section className={BOARD} aria-labelledby="match-veto-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 tabIndex={-1} id="match-veto-title" className={FOCUS_HEADING}>Map veto</h2>
        {remaining !== null && <p role="timer" aria-label="Turn time remaining" className="font-semibold tabular-nums text-text">{remaining}s</p>}
      </div>
      <p aria-live="polite" className="text-body text-text-muted">
        {turn ? seatLabel(turn.seat) + " must " + turn.kind + " a map." : "Both players ready up to reveal who acts first."}
      </p>
      {turn && <p className="text-caption text-text-muted">Coin flip · {seatLabel(room.first)} acts first.</p>}
      <ul className="grid gap-2 sm:grid-cols-2">
        {room.config.maps.map((name, map) => {
          const move = byMap.get(map);
          return <li key={map} className="min-w-0">
            {!move && turn && canVeto ? (
              <Button variant="secondary" fullWidth disabled={blocked}
                className="h-auto min-h-11 justify-start whitespace-normal break-words py-2 text-left"
                onClick={() => { void send({ type: "veto", as: turn.seat, map }); }}>
                {turn.kind === "ban" ? "Ban " : "Pick "}{name}
              </Button>
            ) : <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-2 rounded-lg border border-line px-3 py-2 text-body text-text">
              <span className="min-w-0 break-words">{name}</span>
              {move && <span className="text-caption text-text-muted">{move.kind === "ban" ? "Banned" : "Picked"} · {seatLabel(move.seat)}{move.automatic ? " · Timer" : ""}</span>}
            </div>}
          </li>;
        })}
      </ul>
    </section>
  );
}

function ReplayScoreSource({ report }: { report: NonNullable<Room["replay"]>["reports"][number] | undefined }) {
  if (!report) return <span className="text-caption text-text-muted">Manual score</span>;
  return <span className="text-caption text-text-muted">
    {report.confirmed ? "Replay reported · Confirmed by both players" : "Reported from replay"}
  </span>;
}

type ScoreBoardProps = BoardProps & { roomId: string; replayFeedback: ReplayReportFeedback };

function ReplayControls({ room, role, roomId, blocked, send, replayFeedback }: ScoreBoardProps) {
  if (role !== "a" && role !== "b") return null;
  const playing = room.phase === "play";
  if (!room.replay?.replayScoring) return playing && !room.config.practice
    ? <p className="text-caption text-text-muted">Replay reports are unavailable in this room. Record the score manually.</p>
    : null;
  const canConfirm = room.replay.reports.some(report => report && !report.confirmed && report.submittedBy !== role);
  if (!playing && !canConfirm) return null;
  return <ReplayReportControl roomId={roomId} seat={role} blocked={blocked} send={send} feedback={replayFeedback} />;
}

function ScoreControls({ room, role, roomId, blocked, send, replayFeedback }: ScoreBoardProps) {
  if (role === "watch") return null;
  return <div className="space-y-3">
    <ReplayControls room={room} role={role} roomId={roomId} blocked={blocked} send={send} replayFeedback={replayFeedback} />
    <div className="flex flex-wrap gap-2">
      {room.phase === "play" && SEATS.map(winner => <Button key={winner} variant="secondary" disabled={blocked}
        onClick={() => { void send({ type: "score", winner }); }}>{seatLabel(winner)} won</Button>)}
      <UndoScoreControl room={room} role={role} blocked={blocked} send={send} />
    </div>
  </div>;
}

function UndoScoreControl({ room, role, blocked, send }: BoardProps) {
  if (!room.winners.length || role === "watch") return null;
  if (role !== "host" && !room.replay) return null;
  const requested = room.replay?.undoBy;
  if (requested && requested === role) return <p role="status" className="text-caption text-text-muted">
    Waiting for the other player to undo the last score.
  </p>;
  const label = role === "host" ? "Undo last score" : requested ? "Agree to undo last score" : "Request score undo";
  return <Button variant="secondary" disabled={blocked} onClick={() => { void send({ type: "undo" }); }}>
    {label}
  </Button>;
}

export function ScoreBoard({ room, roomId, role, blocked, send, replayFeedback }: ScoreBoardProps) {
  if (room.phase === "lobby" || room.phase === "veto") return null;
  const complete = room.phase === "complete";
  const next = room.winners.length;
  return (
    <section className={BOARD} aria-labelledby="match-score-title">
      <h2 tabIndex={-1} id="match-score-title" className={FOCUS_HEADING}>Series score</h2>
      <p aria-live="polite" className="text-body text-text-muted">
        {complete ? seatLabel(room.score.a > room.score.b ? "a" : "b") + " wins the series." :
          "Record the winner of game " + (next + 1) + "."}
      </p>
      <ol className="divide-y divide-line">
        {room.order.map((map, index) => <li key={map} className="flex min-h-10 flex-wrap items-center justify-between gap-x-2 py-1.5 text-body text-text">
          <span className="min-w-0 break-words">{index + 1}. {room.config.maps[map]}</span>
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="text-caption font-semibold text-text">
              {room.winners[index] ? seatLabel(room.winners[index]) + " won" : index === next && !complete ? "Up next" : ""}
            </span>
            {room.winners[index] && <ReplayScoreSource report={room.replay?.reports[index]} />}
          </div>
        </li>)}
      </ol>
      <ScoreControls room={room} roomId={roomId} role={role} blocked={blocked} send={send} replayFeedback={replayFeedback} />
    </section>
  );
}
