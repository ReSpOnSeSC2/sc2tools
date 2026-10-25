"use client";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { applyReplayControl, deletionWord, MAX_REPLAY_SELECTION, REPLAY_HIDE_REASONS, type ReplayControlAction, type ReplayControlChange, type ReplayControlTarget } from "@/lib/replayGameControls";

type Props = { targets: readonly ReplayControlTarget[]; scopeKey: string; menu?: boolean; onOpening?: () => void; onComplete?: (changes: ReplayControlChange[]) => void | Promise<void> };
type Action = { kind: ReplayControlAction; targets: ReplayControlTarget[] };

export function GameControlActions(props: Props) {
  const { userId, isLoaded, isSignedIn } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const scope = owner ? `${owner}:${props.scopeKey}` : null;
  const currentScope = useRef(scope); currentScope.current = scope;
  if (!scope) return null;
  return <Actions key={scope} currentScope={currentScope} scope={scope} {...props} />;
}

function Actions({ targets, menu, scope, currentScope, onOpening, onComplete }: Props & { scope: string; currentScope: { current: string | null } }) {
  const { getToken } = useAuth();
  const [action, setAction] = useState<Action | null>(null), [reason, setReason] = useState("other"), [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(0), [message, setMessage] = useState(""), [failed, setFailed] = useState(false);
  const active = useRef(true), busyRef = useRef(false), pending = useRef<AbortController | null>(null), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; pending.current?.abort(); }; }, []);
  const allowed = () => active.current && currentScope.current === scope;
  const complete = async (changes: ReplayControlChange[]) => {
    if (!allowed() || !changes.length) return;
    try { await onComplete?.(changes); } catch { /* The mutation succeeded; refresh can be retried separately. */ }
  };
  async function run(next: Action) {
    if (busyRef.current || !allowed() || !next.targets.length || next.targets.length > MAX_REPLAY_SELECTION) return;
    busyRef.current = true; setBusy(true); setFailed(false); setMessage(""); setProgress(0);
    const controller = new AbortController(); pending.current = controller;
    const changed: ReplayControlChange[] = [];
    try {
      for (const target of next.targets) {
        const result = await applyReplayControl({ gameId: target.gameId, action: next.kind, reason, getToken, allowed, controller });
        if (!allowed()) return;
        changed.push(result); setProgress(changed.length);
      }
      if (!allowed()) return;
      setAction(null); await complete(changed);
      if (allowed()) setMessage(next.kind === "delete" ? `${changed.length} game${changed.length === 1 ? "" : "s"} deleted.` : next.kind === "hide" ? `${changed.length} game${changed.length === 1 ? "" : "s"} hidden from stats.` : `${changed.length} game${changed.length === 1 ? "" : "s"} unhidden.`);
    } catch (error) {
      if (!allowed()) return;
      const remaining = next.targets.filter(target => !changed.some(value => value.gameId === target.gameId));
      setAction(next.kind === "unhide" ? null : { ...next, targets: remaining }); setTyped("");
      setFailed(true); setMessage(`${changed.length ? `${changed.length} completed. ` : ""}${error instanceof Error ? error.message : (error as { message?: string })?.message || "Couldn't finish. Please retry."}`);
      await complete(changed);
    } finally { if (allowed()) { busyRef.current = false; setBusy(false); } if (pending.current === controller) pending.current = null; }
  }
  function open(kind: ReplayControlAction) {
    if (!allowed() || !targets.length || targets.length > MAX_REPLAY_SELECTION) return;
    onOpening?.(); setMessage(""); setFailed(false); setTyped(""); setReason("other");
    const next = { kind, targets: targets.map(target => ({ ...target })) };
    if (kind === "unhide") void run(next); else setAction(next);
  }
  const count = action?.targets.length || 0, deleting = action?.kind === "delete";
  const canUnhide = targets.length > 0 && targets.every(target => target.excluded && !target.pendingDeletion);
  const canHide = targets.length > 0 && targets.every(target => !target.pendingDeletion);
  const disabled = busy || targets.length === 0 || targets.length > MAX_REPLAY_SELECTION;
  const actionClass = menu ? "w-full justify-start" : "";
  return <div className={menu ? "space-y-1" : "flex flex-wrap items-center gap-2"}>
    {canHide ? <Button variant="ghost" className={actionClass} disabled={disabled} onClick={() => open(canUnhide ? "unhide" : "hide")}>{canUnhide ? "Unhide" : "Hide from stats"}</Button> : null}
    <Button variant="ghost" className={`${actionClass} text-danger`} disabled={disabled} onClick={() => open("delete")}>{targets.some(target => target.pendingDeletion) ? "Retry deletion…" : targets.length > 1 ? "Delete selected games…" : "Delete game…"}</Button>
    {busy ? <span role="status" className="text-caption text-text-muted">{progress} of {action?.targets.length || targets.length} completed…</span> : null}
    {message && !action ? <p role={failed ? "alert" : "status"} className={`w-full text-caption ${failed ? "text-danger" : "text-success"}`}>{message}</p> : null}
    <Modal open={action !== null} initialFocusRef={cancel} onClose={() => { if (!busy) setAction(null); }} title={deleting ? count === 1 ? "Delete this game?" : `Delete ${count} games?` : `Hide ${count === 1 ? "this game" : `${count} games`} from stats?`} size="md"
      footer={<><Button ref={cancel} variant="secondary" disabled={busy} onClick={() => setAction(null)}>Cancel</Button><Button variant={deleting ? "danger" : "primary"} loading={busy} disabled={deleting && typed !== deletionWord(count)} onClick={() => { if (action) void run(action); }}>{deleting ? "Delete permanently" : "Hide from stats"}</Button></>}>
      <p className="text-body text-text-muted">{deleting ? "Removes the cloud game record, analysis, original cloud replay and playback artifacts. Active review grants close; discussion text stays. Local replay files are retained. Older snapshots cannot restore these games." : "Keeps your replay and analysis available, while excluding your copy from statistics and scouting. You can Unhide it in Settings → Backups & data."}</p>
      <ul className="my-3 max-h-40 space-y-2 overflow-y-auto rounded-lg border border-border p-3 text-caption">{action?.targets.map(target => <li key={target.gameId} className="break-words"><strong>{target.map || "Replay"}</strong>{target.date ? ` · ${new Date(target.date).toLocaleDateString()}` : ""}<span className="block break-all font-mono text-micro text-text-muted">{target.gameId}</span></li>)}</ul>
      {deleting ? <label className="block text-caption text-text-muted">Type <strong className="font-mono">{deletionWord(count)}</strong> to confirm<Input aria-label={`Type ${deletionWord(count)} to confirm`} value={typed} onChange={event => setTyped(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} /></label> : <fieldset><legend className="mb-2 text-caption font-semibold">Reason for hiding</legend><div className="flex flex-wrap gap-2">{REPLAY_HIDE_REASONS.map(value => <Button key={value.value} variant={reason === value.value ? "primary" : "secondary"} disabled={busy} aria-pressed={reason === value.value} onClick={() => setReason(value.value)}>{value.label}</Button>)}</div></fieldset>}
      {message ? <p role="alert" className="mt-3 text-caption text-danger">{message}</p> : null}
      <div className="mt-4"><LazyHelpLink slug="hide-or-delete-a-game">Hide, delete and retry help</LazyHelpLink></div>
    </Modal>
  </div>;
}
