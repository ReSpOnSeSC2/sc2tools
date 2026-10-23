"use client";

import { useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { QueryState } from "@/components/ui/QueryState";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { coerceRace, coerceVsRace, matchupLabel } from "@/lib/race";
import { useOwnerBuilds } from "@/components/community/useOwnerBuilds";
import { useCustomBuildPage } from "./useCustomBuildPage";
import { BuildPagination } from "./BuildPagination";
import type { CustomBuild } from "./types";

export function PublishPickerModal({ onClose, onChoose, onCreate }: { onClose: () => void; onChoose: (build: CustomBuild) => void; onCreate: () => void }) {
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search, 250);
  const query = useCustomBuildPage({ nameSearch: debounced, sort: "updated", view: "summary" });
  const publications = useOwnerBuilds();
  const initialFocus = useRef<HTMLInputElement>(null);
  const publishedSources = new Set(publications.data?.items.filter((item) => !item.removed).map((item) => item.sourceSlug));
  return <Modal open onClose={onClose} title="Pick a build to publish" description="Your library, most recently updated first. Choose a build to review its public listing." size="lg" initialFocusRef={initialFocus}>
    <div className="space-y-4">
      <Field label="Filter by build name"><Input ref={initialFocus} type="search" value={search} maxLength={120} onChange={(event) => setSearch(event.target.value)} placeholder="Find a saved build" /></Field>
      {publications.error ? <p className="text-caption text-warning">Published badges are temporarily unavailable. <button type="button" onClick={() => void publications.mutate()} className="min-h-11 rounded-md font-semibold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Try again</button></p> : null}
      <QueryState q={query} errorTitle="Your build library is temporarily unavailable" isEmpty={(data) => data.libraryTotal === 0} empty={<EmptyStatePanel title="You don't have any saved builds yet." description="Save a build from a game's build order or create one in the editor." action={<div className="flex flex-wrap items-center gap-3"><Button onClick={() => { onClose(); onCreate(); }}>Create a build</Button><LazyHelpLink slug="custom-builds">Learn how</LazyHelpLink></div>} />}>
        {(data, state) => <div aria-busy={query.isValidating || undefined} className={state.isPreviousData ? "opacity-60" : undefined}>
          {!data.items.length ? <EmptyStatePanel title={search.trim() ? `No builds match “${search.trim()}”` : "No builds on this page"} action={<Button variant="secondary" onClick={() => { setSearch(""); query.resetPage(); }}>Clear filter</Button>} /> : <ul aria-label="Saved builds to publish" className="divide-y divide-border rounded-xl border border-border">{data.items.map((build) => <li key={build.slug}>
            <button type="button" disabled={state.isPreviousData} aria-label={`Publish ${build.name}`} onClick={() => onChoose({ ...build, isPublic: publishedSources.has(build.slug) })} className="flex min-h-16 w-full items-start justify-between gap-3 rounded-lg p-3 text-left hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">
              <span className="min-w-0"><span className="block break-words font-semibold text-text">{build.name}</span><span className="text-caption text-text-muted">{matchupLabel(coerceRace(build.race), coerceVsRace(build.vsRace))}</span></span>
              {publishedSources.has(build.slug) ? <Badge size="sm" variant="neutral">Published</Badge> : null}
            </button>
          </li>)}</ul>}
          <BuildPagination {...query} count={data.items.length} total={data.total} loading={query.isValidating} onPrevious={query.previousPage} onNext={query.nextPage} />
        </div>}
      </QueryState>
    </div>
  </Modal>;
}
