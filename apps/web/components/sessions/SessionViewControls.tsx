"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { changeSessionQuery } from "@/lib/sessionHistoryUrls";

export function SessionViewControls({ query, navigate, refresh }: {
  query: URLSearchParams; navigate: (query: URLSearchParams) => void; refresh: () => unknown;
}) {
  const [day, setDay] = useState(query.get("day") ?? "");
  const [zone, setZone] = useState(query.get("tz") ?? "UTC");
  const selectedDay = query.get("day") ?? "", selectedZone = query.get("tz") ?? "UTC";
  useEffect(() => { setDay(selectedDay); setZone(selectedZone); }, [selectedDay, selectedZone]);
  return <form aria-label="Session output selectors" className="flex flex-wrap items-end gap-3" onSubmit={event => {
    event.preventDefault();
    navigate(changeSessionQuery(query, { day: day || null, tz: zone, windowFrom: null, windowTo: null, sessionRolling: null }));
  }}>
    <Field label="Output day" hint="Selects sessions with a recorded game end on this local day."><Input className="min-h-11" type="date" value={day} onChange={event => setDay(event.target.value)} /></Field>
    <Field label="Session timezone"><Input className="min-h-11" value={zone} onChange={event => setZone(event.target.value)} /></Field>
    <Button type="submit" variant="secondary">Apply day and timezone</Button>
    <Button type="button" variant="ghost" onClick={() => refresh()}>Refresh session view</Button>
  </form>;
}
