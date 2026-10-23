"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useApi } from "@/lib/clientApi";
import type { AdminUserRow, UsersListResp } from "./adminTypes";
import { timeSince } from "./format";
export type ResolvedAdminUser = Pick<AdminUserRow, "userId" | "email" | "gameCount">;
export function UserLookupField({ value, onChange, disabled = false }: { value: ResolvedAdminUser | null; onChange: (user: ResolvedAdminUser | null) => void; disabled?: boolean }) {
  const [text, setText] = useState(""), [query, setQuery] = useState(""), [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const id = useId(), input = useRef<HTMLInputElement>(null);
  useEffect(() => { const timer = window.setTimeout(() => setQuery(text.trim()), 300); return () => window.clearTimeout(timer); }, [text]);
  const users = useApi<UsersListResp>(query ? `/v1/admin/users?search=${encodeURIComponent(query)}&limit=10` : null);
  const options = useMemo(() => users.data?.items ?? [], [users.data]);
  useEffect(() => { const exact = options.find((u) => u.userId === text.trim()); if (exact && query === text.trim() && !value) onChange(exact); }, [options, text, query, value, onChange]);
  if (value) return <div className="flex min-h-11 flex-wrap items-center gap-2 rounded border border-border p-2"><span className="min-w-0 break-all text-caption">{value.email || value.userId} · {value.gameCount} games</span><Button size="sm" variant="ghost" disabled={disabled} onClick={() => { onChange(null); setText(""); setQuery(""); window.setTimeout(() => input.current?.focus(), 0); }}>Change user</Button></div>;
  const choose = (user: AdminUserRow) => { onChange(user); setOpen(false); };
  return <div className="relative space-y-1"><label htmlFor={id} className="text-caption text-text-muted">Find user by email or user ID</label>
    <Input id={id} ref={input} role="combobox" aria-autocomplete="list" aria-expanded={open && options.length > 0} aria-controls={`${id}-list`} aria-activedescendant={open && options[active] ? `${id}-${active}` : undefined}
      value={text} disabled={disabled} autoComplete="off" onFocus={() => setOpen(true)} onChange={(e) => { setText(e.target.value); setActive(0); setOpen(true); }}
      onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); return; } if (!options.length) return; if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length); } if (e.key === "Enter" && open) { e.preventDefault(); choose(options[active]); } }} />
    {open && options.length ? <ul id={`${id}-list`} role="listbox" aria-label="Matching users" className="absolute z-20 max-h-72 w-full overflow-y-auto rounded border border-border bg-bg-surface shadow-xl">{options.map((user, index) => <li key={user.userId} id={`${id}-${index}`} role="option" aria-selected={index === active} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(user)} className={`cursor-pointer p-3 text-caption ${index === active ? "bg-accent/15" : ""}`}><span className="block break-all font-semibold">{user.email || "No email"} · {user.userId}</span><span>{user.gameCount} games · {user.opponentCount} opponents · {timeSince(user.lastActivity)}</span></li>)}</ul> : null}
    {users.error ? <p role="alert" className="text-caption text-danger">Lookup failed. <Button size="sm" variant="ghost" onClick={() => void users.mutate()}>Retry</Button></p> : query && !users.isValidating && !options.length ? <p className="text-caption text-text-muted">No user with that ID or email.</p> : null}
  </div>;
}
