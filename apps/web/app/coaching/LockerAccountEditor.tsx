"use client";

import { useState, type FormEvent } from "react";
import { useApi, type ClientApiError } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import type { LockerAccount, LockerCoach } from "./lockerRosterModel";

type Props = {
  kind: "student" | "coach";
  coaches: LockerCoach[];
  coachId: string;
  alreadyLinked: Set<string>;
  busy: boolean;
  onClose: () => void;
  onAdd: (account: LockerAccount, name: string, note: string, coachId: string) => void;
};

export function LockerAccountEditor({ kind, coaches, coachId, alreadyLinked, busy, onClose, onAdd }: Props) {
  const lookup = useApi<{ users: LockerAccount[] }>("/v1/coaching/users", {
    revalidateOnMount: false, revalidateOnFocus: false, revalidateOnReconnect: false,
  });
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<LockerAccount[] | null>(null);
  const [account, setAccount] = useState<LockerAccount | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [coach, setCoach] = useState(coachId);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (searching || query.trim().length < 3) return;
    setSearching(true);
    setError("");
    setRows(null);
    try {
      const result = await lookup.request<{ users: LockerAccount[] }>({ method: "POST", body: JSON.stringify({ q: query.trim() }) });
      setRows(result.users);
    } catch (err) {
      setError((err as Partial<ClientApiError>).message || "Account lookup failed. Try again.");
    } finally { setSearching(false); }
  }

  return (
    <Modal open title={kind === "student" ? "Add student" : "Add coach"} onClose={() => { if (!busy) onClose(); }}>
      {account ? (
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          if (!busy && name.trim()) onAdd(account, name.trim(), note.trim(), coach);
        }}>
          <p className="break-all text-caption text-text-muted">{account.email}</p>
          <Field label="Display name" required><Input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></Field>
          {kind === "student" ? (
            <>
              <Field label="Focus note"><Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} /></Field>
              {coaches.length > 1 ? <Field label="Assigned coach"><Select value={coach} onChange={(event) => setCoach(event.target.value)}>
                {coaches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </Select></Field> : null}
            </>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !name.trim() || (kind === "student" && !coach)}>{busy ? "Saving…" : kind === "student" ? "Add student" : "Add coach"}</Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setAccount(null)}>Back to search</Button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => void search(event)}>
            <Field className="min-w-0 flex-1 basis-48" label="Search by email" hint="Enter at least three characters.">
              <Input value={query} onChange={(event) => { setQuery(event.target.value); setRows(null); setError(""); }} maxLength={254} disabled={searching} autoComplete="off" />
            </Field>
            <Button type="submit" disabled={searching || query.trim().length < 3}>{searching ? "Searching…" : "Search"}</Button>
          </form>
          {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}
          {rows?.length === 0 ? <p role="status" className="text-caption text-text-muted">No matching accounts.</p> : null}
          {rows?.length ? <ul aria-label="Matching accounts" className="space-y-2">{rows.map((row) => {
            const unavailable = alreadyLinked.has(row.userId) ? "Already linked" : kind === "coach" && !row.hasAgent ? "Agent pairing required" : null;
            return <li key={row.userId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2">
              <span className="min-w-0 break-all text-caption">{row.email}</span>
              {unavailable ? <span className="text-caption text-text-muted">{unavailable}</span>
                : <Button size="sm" variant="secondary" aria-label={"Select " + row.email} onClick={() => setAccount(row)}>Select</Button>}
            </li>;
          })}</ul> : null}
        </div>
      )}
    </Modal>
  );
}
