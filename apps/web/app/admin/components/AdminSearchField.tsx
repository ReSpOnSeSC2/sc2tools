"use client";
import { useEffect, useId, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { adminBrowserLocation } from "./useAdminQueryState";

export function AdminSearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  const [draft, setDraft] = useState(value), input = useRef<HTMLInputElement>(null), id = useId();
  const pathname = usePathname(), search = useSearchParams().toString(), key = `${pathname}?${search}`;
  const observed = useRef({ key, value }), submitted = useRef<string | null>(null), change = useRef(onChange); change.current = onChange;
  // An acknowledgement of our last submitted value must not replace newer typing.
  // Other search changes synchronize during render, before any old timer can fire.
  if (key !== observed.current.key || value !== observed.current.value) {
    if (value !== observed.current.value) { if (value !== submitted.current) setDraft(value); submitted.current = null; }
    observed.current = { key, value };
  }
  useEffect(() => {
    const history = () => { submitted.current = null; observed.current.key = "history-navigation"; setDraft(new URLSearchParams(window.location.search).get("q") || ""); };
    window.addEventListener("popstate", history); return () => window.removeEventListener("popstate", history);
  }, []);
  useEffect(() => {
    if (draft === value) return;
    const origin = adminBrowserLocation(), timer = setTimeout(() => {
      const live = adminBrowserLocation();
      if (observed.current.key !== key || live?.key !== origin?.key && !(live?.path === pathname && submitted.current !== null && new URLSearchParams(live.search).get("q") === submitted.current)) return;
      submitted.current = draft; change.current(draft);
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, value, key, pathname]);
  return <Field label="Search" htmlFor={id}><div id={`${id}-group`} className="flex gap-2"><Input id={id} ref={input} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setDraft(""); input.current?.focus(); } }} placeholder={placeholder} spellCheck={false} autoCapitalize="none" autoCorrect="off" />
    {draft ? <Button variant="ghost" size="sm" aria-label="Clear search" onClick={() => { setDraft(""); input.current?.focus(); }}>×</Button> : null}</div></Field>;
}
