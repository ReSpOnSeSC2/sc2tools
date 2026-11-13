"use client";

import { useState, type Ref } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { deriveSeatKey, invitePath, matchResultCard, matchRoomObsPath, resultText, type Room, type RoomInvite, type Seat } from "@/lib/matchRoom";
import { useCopy } from "@/lib/useCopy";

function RoomObsLink({ roomId }: { roomId: string }) {
  const [showCredit, setShowCredit] = useState(true);
  const source = matchRoomObsPath(roomId, showCredit);
  const copy = useCopy({ scopeKey: source });

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <h3 className="font-display text-body-lg font-semibold text-text">OBS Browser Source</h3>
      <p className="text-caption text-text-muted">Paste this link into OBS to show the veto and score with neutral seat labels.</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-44 max-w-full space-y-1 text-caption text-text-muted">
          <label htmlFor="match-obs-credit">Overlay credit</label>
          <Select id="match-obs-credit" selectSize="lg" value={showCredit ? "show" : "hide"}
            onChange={event => setShowCredit(event.target.value === "show")}>
            <option value="show">Show</option><option value="hide">Hide</option>
          </Select>
        </div>
        <Button variant="secondary" disabled={copy.pending}
          onClick={() => { void copy.copy(new URL(source, window.location.origin).href); }}>
          Copy OBS source
        </Button>
      </div>
      {copy.copied && <p role="status" className="text-caption text-text-muted">OBS source copied.</p>}
      {copy.fallbackText && <Input aria-label="OBS source URL" readOnly value={copy.fallbackText} ref={copy.inputRef as Ref<HTMLInputElement>} />}
    </div>
  );
}

export function InviteLinks({ invite }: { invite: Extract<RoomInvite, { key: string }> }) {
  const copy = useCopy();
  const [label, setLabel] = useState("");
  const [error, setError] = useState(false);
  const [building, setBuilding] = useState(false);

  async function copyInvite(role: Seat | "watch", name: string) {
    setLabel(name);
    setError(false);
    setBuilding(true);
    try {
      const path = role === "watch" ? invitePath({ id: invite.id, role }) :
        invitePath({ id: invite.id, role, key: await deriveSeatKey(invite.key, role) });
      await copy.copy(new URL(path, window.location.origin).href);
    } catch {
      setError(true);
    } finally {
      setBuilding(false);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-line bg-bg-surface p-4" aria-labelledby="match-invite-title">
      <h2 id="match-invite-title" className="font-display text-h3 font-bold text-text">Invite players and spectators</h2>
      <p className="text-caption text-text-muted">Send each player their own seat link. Keep this host link for yourself.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={building} onClick={() => { void copyInvite("a", "Seat A link"); }}>Copy Seat A link</Button>
        <Button variant="secondary" disabled={building} onClick={() => { void copyInvite("b", "Seat B link"); }}>Copy Seat B link</Button>
        <Button variant="secondary" disabled={building} onClick={() => { void copyInvite("watch", "Watch link"); }}>Copy watch link</Button>
      </div>
      {copy.copied && <p role="status" className="text-caption text-text-muted">{label} copied.</p>}
      {copy.fallbackText && <Input aria-label={label} readOnly value={copy.fallbackText} ref={copy.inputRef as Ref<HTMLInputElement>} />}
      {error && <p role="alert" className="text-caption text-danger">The invite could not be prepared. Try copying the link again.</p>}
      <RoomObsLink roomId={invite.id} />
    </section>
  );
}

const IMAGE_IDLE = { busy: false, message: "", error: false };

export function MatchResultExport({ room }: { room: Room }) {
  const copy = useCopy({ scopeKey: room.rev });
  const [image, setImage] = useState(IMAGE_IDLE);
  function copyText(style: "discord" | "reddit") {
    setImage(IMAGE_IDLE);
    void copy.copy(resultText(room, style));
  }
  async function shareImage() {
    copy.clear();
    setImage({ busy: true, message: "", error: false });
    try {
      const { sharePersonalCard } = await import("@/lib/personalShareCardImage");
      const delivery = await sharePersonalCard(matchResultCard(room));
      setImage({ busy: false, message: delivery?.feedback ?? "", error: false });
    } catch {
      setImage({ busy: false, message: "The image could not be shared. Try again or copy the score.", error: true });
    }
  }
  return (
    <section className="space-y-3 rounded-xl border border-line bg-bg-surface p-4" aria-labelledby="match-result-title">
      <h2 id="match-result-title" className="font-display text-h3 font-bold text-text">Share the result</h2>
      <p className="text-caption text-text-muted">Share the score with neutral seat labels.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={copy.pending || image.busy} onClick={() => copyText("discord")}>Copy for Discord</Button>
        <Button variant="secondary" disabled={copy.pending || image.busy} onClick={() => copyText("reddit")}>Copy for Reddit</Button>
        <Button variant="secondary" disabled={copy.pending} loading={image.busy} onClick={() => { void shareImage(); }}>Share result image</Button>
      </div>
      {copy.copied && <p role="status" className="text-caption text-text-muted">Result copied.</p>}
      {copy.fallbackText && <textarea aria-label="Result text" className="block w-full rounded-lg border border-line bg-bg-surface p-3 text-body"
        readOnly rows={5} value={copy.fallbackText} ref={copy.inputRef as Ref<HTMLTextAreaElement>} />}
      {image.message && <p role={image.error ? "alert" : "status"} className={image.error ? "text-caption text-danger" : "text-caption text-text-muted"}>
        {image.message}
      </p>}
    </section>
  );
}
