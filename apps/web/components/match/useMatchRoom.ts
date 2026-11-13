"use client";

import { useEffect, useRef, useState } from "react";
import { pollDelay, type Room, type RoomAction, type RoomInvite } from "@/lib/matchRoom";
import { deleteRoom, readRoom, RoomRequestError, roomErrorText, writeRoom } from "@/lib/matchRoomClient";

type Frame = { room: Room; receivedAt: number };
type PollMode = "room" | "obs";
type PollOptions = { mode: PollMode; publish: (frame: Frame | null) => void; status: (error: string, gone: boolean) => void };
const MAX_ROOM_LIFE_MS = 14 * 86_400_000;
type RoomSession = {
  stop: AbortController;
  frame: Frame | null;
  gone: boolean;
  reading: boolean;
  refreshAgain: boolean;
  retry: () => void;
  finish: () => void;
  accept: (room: Room) => void;
};

/** A session owns its polling timer and abort signal until its invite is retired. */
function pollRoom(id: string, { mode, publish, status }: PollOptions) {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryAt = 0;
  const clear = () => clearTimeout(timer);
  const expiry = watchExpiry(stop.signal, mode);
  const session: RoomSession = {
    stop, frame: null, gone: false, reading: false, refreshAgain: false, retry: refresh, finish, accept,
  };

  function finish() {
    session.gone = true;
    clear();
    expiry.clear();
    session.frame = null;
    publish(null);
    status("", true);
  }
  function accept(room: Room) { publishRoomFrame(session, room, expiry, publish); }
  function schedule() {
    clear();
    if (stop.signal.aborted || session.gone) return;
    const delay = roomPollDelay(mode, session.frame?.room.phase);
    timer = setTimeout(refresh, session.refreshAgain ? 0 : Math.max(delay, retryAt - Date.now()));
    session.refreshAgain = false;
  }
  function failed(error: unknown, startedAtRev: number | undefined) {
    if (!isCurrentReadError(session, error, startedAtRev)) return;
    retryAt = error instanceof RoomRequestError && error.retryMs > 0 ? Date.now() + error.retryMs : 0;
    session.refreshAgain = false;
    status(roomErrorText(error, "read"), false);
  }
  function refresh() {
    if (stop.signal.aborted || session.gone || (mode === "obs" && retryAt > Date.now())) return;
    if (session.reading) { session.refreshAgain = true; return; }
    clear();
    session.reading = true;
    const rev = session.frame?.room.rev;
    void readRoom(id, rev, stop.signal).then(room => {
      if (stop.signal.aborted || session.gone) return;
      if (room) session.accept(room);
      retryAt = 0;
      if (!session.gone) status("", false);
    }, error => failed(error, rev)).finally(() => {
      session.reading = false;
      schedule();
    });
  }
  observeVisibility(stop.signal, () => {
    clear();
    if (document.visibilityState === "visible" && retryAt <= Date.now()) refresh();
    else if (!session.reading) schedule();
  });
  stop.signal.addEventListener("abort", clear, { once: true });
  refresh();
  return session;
}

function publishRoomFrame(session: RoomSession, room: Room, expiry: ReturnType<typeof watchExpiry>, publish: PollOptions["publish"]) {
  if (session.stop.signal.aborted || session.gone || !isNewerFrame(session.frame, room)) return;
  if (!expiry.arm(room, session.finish)) return;
  session.frame = { room, receivedAt: Date.now() };
  publish(session.frame);
}

function roomPollDelay(mode: PollMode, phase: Room["phase"] | undefined) {
  const hidden = document.visibilityState === "hidden";
  return mode === "obs" && !hidden ? 5_000 : pollDelay(phase, hidden);
}

function watchExpiry(signal: AbortSignal, mode: PollMode) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => clearTimeout(timer);
  signal.addEventListener("abort", clear, { once: true });
  function arm(room: Room, finish: () => void) {
    if (mode !== "obs") return true;
    const remaining = room.expiresAt - room.serverTime;
    if (remaining <= 0) { finish(); return false; }
    clear();
    timer = setTimeout(finish, Math.min(remaining, MAX_ROOM_LIFE_MS));
    return true;
  }
  return { arm, clear };
}

function observeVisibility(signal: AbortSignal, callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  signal.addEventListener("abort", () => document.removeEventListener("visibilitychange", callback), { once: true });
}

function isCurrentReadError(session: RoomSession, error: unknown, startedAtRev: number | undefined) {
  if (session.stop.signal.aborted || session.gone) return false;
  if (error instanceof RoomRequestError && error.code === "match_room_missing") {
    session.finish();
    return false;
  }
  return session.frame?.room.rev === startedAtRev;
}

function isNewerFrame(frame: Frame | null, room: Room) {
  if (!frame) return true;
  return room.rev > frame.room.rev || (room.rev === frame.room.rev && room.serverTime > frame.room.serverTime);
}

function hasWritableRoom(session: RoomSession | null, busy: boolean): session is RoomSession & { frame: Frame } {
  return Boolean(session?.frame) && !session?.gone && !busy;
}

export function useMatchRoom(invite: RoomInvite, mode: PollMode = "room") {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [reading, setReading] = useState({ error: "", gone: false });
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const current = useRef<RoomSession | null>(null);

  useEffect(() => {
    const session = pollRoom(invite.id, { mode, publish: setFrame, status: (error, gone) => setReading({ error, gone }) });
    current.current = session;
    return () => session.stop.abort();
  }, [invite.id, mode]);

  async function mutate(action: RoomAction | "delete", displayedRev: number) {
    const session = current.current;
    if (invite.role === "watch" || !hasWritableRoom(session, busyRef.current)) return false;
    busyRef.current = true;
    setBusy(true);
    setActionError("");
    try {
      if (action === "delete") {
        await deleteRoom(invite, session.stop.signal);
        if (!session.stop.signal.aborted) session.finish();
      } else {
        session.accept(await writeRoom(invite, displayedRev, action, session.stop.signal));
        session.retry();
      }
      return !session.stop.signal.aborted;
    } catch (error) {
      if (!session.stop.signal.aborted) handleError(session, error, setActionError);
      return false;
    } finally {
      busyRef.current = false;
      if (!session.stop.signal.aborted) setBusy(false);
    }
  }
  return { frame, reading, actionError, busy, mutate, retry: () => current.current?.retry() };
}

function handleError(session: RoomSession, error: unknown, show: (text: string) => void) {
  if (error instanceof RoomRequestError && error.code === "match_room_missing") {
    session.finish();
    return;
  }
  show(roomErrorText(error, "write"));
  if (!(error instanceof RoomRequestError) || error.status === 409 || error.status === 404) session.retry();
}
