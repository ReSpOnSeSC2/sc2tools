"use client";
import { useState } from "react";
import { normalizedBlockedUserSet } from "@/lib/multichat/appearance";
import { DOCK_BLOCKLIST_MAX } from "./dockConstants";

export function DockBlockedUsers({ users, managedUsers, busy, ready, onUnblock }: {
  users: ReadonlyArray<string>; managedUsers: ReadonlyArray<string>; busy: boolean;
  ready: boolean; onUnblock: (user: string) => void;
}) {
  const [query, setQuery] = useState("");
  const managed = normalizedBlockedUserSet(managedUsers);
  const all = [...normalizedBlockedUserSet([...users, ...managedUsers])];
  const shown = all.filter((user) => user.includes(query.trim().toLowerCase()));
  return <details className="mt-3 rounded-md border border-border bg-bg-surface p-2.5">
    <summary className="cursor-pointer text-caption font-semibold text-text">Blocked users ({all.length})</summary>
    <p className="mt-2 text-micro text-text-muted">{users.length} of {DOCK_BLOCKLIST_MAX} Dock blocks</p>
    <label className="mt-2 block text-caption text-text-muted">Search blocked users
      <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} className="mt-1 w-full rounded border border-border bg-bg-elevated px-2 py-1 text-text" />
    </label>
    <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">{shown.map((user) => <li key={user} className="flex flex-wrap items-center justify-between gap-2 text-caption text-text">
      <span className="break-all">{user}</span>
      {managed.has(user) ? <a className="text-text-muted underline" href="/settings?tab=overlay" target="_blank" rel="noopener noreferrer">Managed in Settings → Overlay</a>
        : <button type="button" disabled={busy || !ready} onClick={() => onUnblock(user)} className="rounded border border-border px-2 py-1 disabled:opacity-50">Unblock <span className="sr-only">{user}</span></button>}
    </li>)}</ul>
    {!shown.length ? <p className="mt-2 text-caption text-text-muted">{all.length ? "No matching users." : "No blocked users."}</p> : null}
  </details>;
}
