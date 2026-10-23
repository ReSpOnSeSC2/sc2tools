"use client";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

export function AdminSearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  const [draft, setDraft] = useState(value), input = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(value), [value]);
  const update = (text: string) => { setDraft(text); onChange(text); };
  return <Field label="Search"><div className="flex gap-2"><Input ref={input} value={draft} onChange={event => update(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); update(""); input.current?.focus(); } }} placeholder={placeholder} spellCheck={false} autoCapitalize="none" autoCorrect="off" />
    {draft ? <Button variant="ghost" size="sm" aria-label="Clear search" onClick={() => { update(""); input.current?.focus(); }}>×</Button> : null}</div></Field>;
}
