"use client";
import { useState } from "react";
import { AUDIENCE_LABELS, WHATS_NEW, WHATS_NEW_CATEGORIES, type AnnouncementAudience } from "@/lib/whatsNew";
import { WhatsNewEntries } from "./WhatsNewEntries";

export function Changelog() {
  const [category, setCategory] = useState<AnnouncementAudience | "all">("all");
  const entries = WHATS_NEW.filter((entry) => category === "all" || entry.audience === category);
  return <div className="space-y-5"><div className="flex flex-wrap gap-2" aria-label="Changelog categories">{(["all", ...WHATS_NEW_CATEGORIES] as const).map((kind) => <button key={kind} type="button" aria-pressed={category === kind} onClick={() => setCategory(kind)} className={`min-h-11 rounded-full border border-border px-3 py-2 text-caption focus-visible:ring-2 focus-visible:ring-accent ${category === kind ? "bg-accent/15 text-accent-cyan" : "text-text-muted hover:bg-bg-elevated"}`}>{kind === "all" ? "All" : AUDIENCE_LABELS[kind]}</button>)}</div>{entries.length ? <WhatsNewEntries entries={entries} /> : <p className="text-body text-text-muted">No {category === "all" ? "" : AUDIENCE_LABELS[category] + " "}updates yet.</p>}</div>;
}
