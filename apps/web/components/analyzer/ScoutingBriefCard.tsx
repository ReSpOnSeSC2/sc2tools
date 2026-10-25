"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { buildScoutingBrief } from "@/lib/scoutingBrief";
import type { ScoutingBriefProfile } from "@/lib/dossierTypes";

export function ScoutingBriefCard({ profile }: { profile: ScoutingBriefProfile }) {
  const lines = buildScoutingBrief(profile), text = lines.join("\n");
  const [copied, setCopied] = useState(false), [fallback, setFallback] = useState("");
  const field = useRef<HTMLTextAreaElement>(null), generation = useRef({ id: 0 });
  const currentText = useRef(text); currentText.current = text;
  useEffect(() => { const state = generation.current; state.id++; setCopied(false); setFallback(""); return () => { state.id++; }; }, [text]);
  useEffect(() => { if (fallback) { field.current?.focus(); field.current?.select(); } }, [fallback]);
  const copy = async () => {
    const attempt = ++generation.current.id, current = () => generation.current.id === attempt && currentText.current === text;
    try { await navigator.clipboard.writeText(text); if (current()) { setCopied(true); setFallback(""); } }
    catch { if (current()) setFallback(text); }
  };
  return <Card title="10-second brief" headingLevel={3} right={<Button variant="ghost" onClick={() => { void copy(); }}>Copy brief</Button>}>
    <ul className="space-y-2 text-body-sm text-text-muted">{lines.map((line, index) => <li key={index} className="break-words">{line}</li>)}</ul>
    <p className="mt-3 text-micro text-text-dim">Your recorded games in this dossier&apos;s scope. Counts show the sample behind each line.</p>
    {copied ? <p role="status" className="mt-2 text-caption text-success">Brief copied.</p> : null}
    {fallback ? <label className="mt-3 block text-caption text-text-muted">Copy this scouting brief<textarea ref={field} value={fallback} readOnly onFocus={event => event.currentTarget.select()} className="mt-2 min-h-32 w-full rounded-lg border border-border bg-bg-surface p-3 text-caption text-text" /></label> : null}
  </Card>;
}
