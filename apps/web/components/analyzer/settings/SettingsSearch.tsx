"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Combobox } from "@/components/ui/Combobox";
import { SETTINGS_FIELDS, settingsFieldHref } from "@/lib/settingsIndex";
import { SETTINGS_TABS } from "@/lib/settingsRegistry";
import { usePageSearchShortcut } from "@/lib/usePageSearchShortcut";

const OPTIONS = SETTINGS_FIELDS.map(field => ({
  value: field.id,
  label: field.label,
  description: SETTINGS_TABS.find(tab => tab.id === field.tab)?.label,
  searchTerms: field.synonyms,
}));

/** Static labels only: matching never mounts a settings body or reads private data. */
export function SettingsSearch({ ownerKey, onNavigate }: {
  ownerKey: string | null;
  onNavigate: (href: string) => void;
}) {
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const lifetime = useMemo(() => ({}), [ownerKey, query]);
  const latest = useRef(lifetime); latest.current = lifetime;
  const navigate = useRef(onNavigate);
  // Publish only a committed Shell guard. A suspended/abandoned render must
  // never lend its tab or dirty-state closure to an existing result callback.
  useLayoutEffect(() => { navigate.current = onNavigate; }, [onNavigate]);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    input.current = root.current?.querySelector<HTMLInputElement>('input[role="combobox"]') ?? null;
    return () => { mounted.current = false; input.current = null; };
  }, []);
  usePageSearchShortcut(input);
  return <div ref={root} className="mb-5 min-w-0">
    <Combobox label="Find a setting" placeholder="Search settings…" value={query} options={OPTIONS}
      onInputChange={setQuery} emptyMessage="No settings match. Try another word."
      onChange={id => {
        if (!mounted.current || latest.current !== lifetime) return;
        const field = SETTINGS_FIELDS.find(candidate => candidate.id === id);
        if (field) navigate.current(settingsFieldHref(field));
      }} />
    <p className="mt-1 text-caption text-text-muted">Press / outside a field to find a setting.</p>
  </div>;
}
