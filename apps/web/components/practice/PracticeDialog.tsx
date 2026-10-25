"use client";

import { useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { GHOST_MATCHUPS, type GhostMatchupKey } from "@/lib/ghostBuild";
import { useGhostPractice } from "@/lib/useGhostPractice";

export function PracticeDialog({ name, race, matchup, busy, message, onAssign, onClose }: {
  name: string; race?: string; matchup?: GhostMatchupKey; busy: boolean; message: string;
  onAssign: (slot: GhostMatchupKey) => Promise<void>; onClose: () => void;
}) {
  const practice = useGhostPractice();
  const options = GHOST_MATCHUPS.filter(slot => !race || slot[0] === race);
  const [slot, setSlot] = useState<GhostMatchupKey>(matchup ?? options[0]);
  const existing = practice.config.slots[slot];
  return <Modal open onClose={onClose} title={`Practice ${name}`} description="Choose the matchup Ghost should coach. Each matchup has one account assignment." size="sm">
    <div className="space-y-4">
      <label className="block text-caption font-semibold">Matchup<select value={slot} onChange={event => setSlot(event.target.value as GhostMatchupKey)} disabled={busy} className="mt-1 block min-h-11 w-full rounded border border-border bg-bg-surface px-3 text-text">{options.map(option => <option key={option}>{option}</option>)}</select></label>
      {practice.loading ? <p role="status" className="text-caption text-text-muted">Loading current assignment…</p> : existing ? <p className="break-words text-caption text-text-muted">This replaces “{existing.name}” for {slot}. The other matchups stay assigned.</p> : <p className="text-caption text-text-muted">No build is currently assigned for {slot}.</p>}
      {practice.readError ? <p className="text-caption text-warning">Couldn&apos;t check the current assignment. <button className="min-h-11 px-2 underline" onClick={practice.retry}>Try again</button></p> : null}
      <Button disabled={busy || practice.loading || !!practice.readError} loading={busy} onClick={() => void onAssign(slot)}>Practice in {slot}</Button>
      {message ? <p role="status" className="break-words text-caption text-text-muted">{message}</p> : null}
      <p className="text-caption text-text-muted">Saved reference build orders are preferred, followed by the source replay and then positive rule deadlines as checkpoints. Your permanent Ghost URL receives changes automatically.</p>
      <Link href="/settings?tab=overlay&section=look" className="inline-flex min-h-11 items-center text-caption text-accent underline">Open Ghost settings</Link>
    </div>
  </Modal>;
}
