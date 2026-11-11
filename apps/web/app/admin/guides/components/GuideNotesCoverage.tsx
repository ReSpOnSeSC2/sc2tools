"use client";

import { Fragment, useState } from "react";
import { fmtDate } from "@/lib/format";
import { GUIDE_MATCHUPS, guideBuildOptions, guideDisplayName } from "@/lib/guides/slugs";
import type { GuideAdminNote } from "@/lib/guides/types";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { guideNoteKey, type GuideSelection } from "./guidesAdminShared";

export function GuideNotesCoverage({ notes, dirtyKeys, onSelect }: {
  notes: ReadonlyMap<string, GuideAdminNote>;
  dirtyKeys: string[];
  onSelect: (selection: GuideSelection) => void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const dirty = new Set(dirtyKeys);
  return <Card>
    <h2 className="mb-3 text-lg font-semibold">Notes coverage</h2>
    <div className="overflow-x-auto">
      <table className="w-full text-left text-caption" aria-label="Notes coverage by matchup">
        <thead><tr className="text-text-muted"><th scope="col" className="py-2">Matchup</th><th scope="col" className="py-2">Guides with notes</th><th scope="col" className="py-2">Last updated</th></tr></thead>
        <tbody className="divide-y divide-border">
          {GUIDE_MATCHUPS.map(matchup => {
            const builds = guideBuildOptions(matchup).map(option => {
              const key = guideNoteKey(matchup, option.name);
              return { name: option.name, key, note: notes.get(key) };
            });
            const published = builds.filter(build => build.note?.body?.trim());
            const latest = published.map(build => build.note!.updatedAt).sort().at(-1);
            const open = expanded.includes(matchup);
            return <Fragment key={matchup}>
              <tr>
                <th scope="row" className="py-1"><Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setExpanded(old => open ? old.filter(item => item !== matchup) : [...old, matchup])}>{matchup}</Button></th>
                <td className="py-2"><span>{published.length}/{builds.length}</span>{builds.some(build => dirty.has(build.key)) ? <span className="ml-2 text-warning">Unsaved</span> : null}</td>
                <td className="py-2 text-text-muted">{latest ? fmtDate(latest) : "—"}</td>
              </tr>
              {open ? <tr><td colSpan={3} className="pb-3">
                <ul aria-label={`${matchup} guide notes`} className="space-y-1">
                  {builds.map(build => <li key={build.key} className="flex flex-wrap items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => onSelect({ matchup, buildKey: build.name })}>{guideDisplayName(build.name)}</Button>
                    <span className={dirty.has(build.key) ? "text-warning" : "text-text-muted"}>{dirty.has(build.key) ? "Unsaved" : build.note?.body?.trim() ? "Has notes" : "No notes"}</span>
                  </li>)}
                </ul>
              </td></tr> : null}
            </Fragment>;
          })}
        </tbody>
      </table>
    </div>
  </Card>;
}
