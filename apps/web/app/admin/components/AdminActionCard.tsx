"use client";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DestructiveConfirmDialog } from "@/components/ui/DestructiveConfirmDialog";
import { useAdminAction, type AdminActionResult } from "./useAdminAction";
import { UserLookupField, type ResolvedAdminUser } from "./UserLookupField";
import { useState } from "react";
export function repairResult(result: AdminActionResult, wipe: boolean) {
  return wipe ? `Wiped ${result.games ?? 0} games, ${result.opponents ?? 0} opponents, ${result.macroJobs ?? 0} macro jobs.`
    : `Games kept: ${result.games ?? "—"} · Opponents rebuilt: ${result.opponents ?? result.droppedRows ?? "—"} · Macro jobs kept: ${result.macroJobs ?? "—"}.`;
}
export function AdminActionCard({ action, user: fixedUser, title, onDone }: { action: "rebuild-opponents" | "wipe-games"; user?: ResolvedAdminUser; title?: string; onDone?: () => void }) {
  const [selected, setSelected] = useState<ResolvedAdminUser | null>(null), user = fixedUser || selected;
  const { state, begin, dismiss, run } = useAdminAction(onDone), wipe = action === "wipe-games", busy = state.kind === "busy";
  const label = title || (wipe ? "Wipe all games for user…" : "Rebuild opponents for user…");
  return <Card padded><h2 className="text-body font-semibold text-text">{label}</h2>
    <p className="my-2 text-caption text-text-muted">{wipe ? "Permanently removes replay history; the account and custom builds are kept. This cannot be undone." : "Recomputes derived opponent counters from stored games and repairs identity lookups."} <a className="underline" href="https://github.com/ReSpOnSeSC2/sc2tools/blob/main/docs/admin-console.md#repairing-a-users-data" target="_blank" rel="noopener noreferrer">Repairing a user&apos;s data</a></p>
    {!fixedUser ? <UserLookupField value={selected} onChange={setSelected} disabled={busy || state.kind === "confirm"} /> : <p className="break-all text-caption text-text-muted">{fixedUser.email || fixedUser.userId}</p>}
    {state.kind === "idle" ? <Button className="mt-3" variant={wipe ? "danger" : "primary"} disabled={!user} onClick={() => { if (user) begin(`/v1/admin/users/${encodeURIComponent(user.userId)}/${action}`, wipe ? {expectedGames:user.gameCount} : undefined); }}>{wipe ? "Wipe games" : "Rebuild opponents"}</Button> : null}
    {state.kind === "error" || state.kind === "done" ? <div className="mt-3 space-y-2"><p role={state.kind === "error" ? "alert" : "status"} className={state.kind === "error" ? "text-caption text-danger" : "text-caption text-success"}>{state.kind === "error" ? state.message : repairResult(state.result, wipe)}</p><div className="flex gap-2"><Button variant="ghost" size="sm" onClick={dismiss}>Dismiss</Button>{state.kind === "done" && user ? <Link className="inline-flex min-h-11 items-center text-caption text-accent underline" href={`/admin/users/${encodeURIComponent(user.userId)}`}>Open user →</Link> : null}</div></div> : null}
    {busy ? <p role="status" className="mt-3 text-caption">{wipe ? "Wiping…" : "Rebuilding…"}</p> : null}
    {wipe ? <DestructiveConfirmDialog open={state.kind === "confirm" || busy} loading={busy} onClose={dismiss} onConfirm={() => void run()} confirmWord={user?.email || user?.userId || ""} confirmDisabled={!user} title="Permanently wipe replay history?" description={`This deletes exactly ${user?.gameCount ?? 0} games, plus their derived opponents and macro jobs. The account and custom builds are kept. This cannot be undone.`} confirmLabel="Wipe permanently" />
      : <ConfirmDialog open={state.kind === "confirm" || busy} loading={busy} onClose={dismiss} onConfirm={() => void run()} title="Rebuild opponents?" description="Recompute derived counters from stored games. Games, the account and custom builds are kept." confirmLabel="Rebuild" />}
  </Card>;
}
