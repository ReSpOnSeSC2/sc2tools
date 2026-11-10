"use client";

import { useId, useState } from "react";
import { Dices, Download, Globe, GlobeLock, Tag, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { TAG_MAX_LENGTH } from "@/lib/buildLibrary";

export type BulkAction = "randomizer" | "publish" | "unpublish" | "delete" | "export";

/**
 * Selection mode's action bar: "N selected", Select all on page, tag
 * (add or remove one tag), add to the randomizer pool, publish or
 * unpublish, delete (one confirmation) and export. Sticks to the bottom
 * of the viewport so it stays reachable on phones.
 */
export function BuildBulkBar({
  count,
  pageCount,
  busy,
  onSelectAll,
  onClear,
  onDone,
  onTag,
  onAction,
}: {
  count: number;
  pageCount: number;
  busy: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onDone: () => void;
  onTag: (tag: string, mode: "add" | "remove") => void;
  onAction: (action: BulkAction) => void;
}) {
  const [tagging, setTagging] = useState(false);
  const [tag, setTag] = useState("");
  const tagId = useId();
  const none = count === 0 || busy;
  const applyTag = (mode: "add" | "remove") => {
    const value = tag.replace(/\s+/g, " ").trim();
    if (!value) return;
    onTag(value, mode);
    setTag("");
    setTagging(false);
  };

  return (
    <section
      aria-label="Bulk actions"
      className="sticky bottom-3 z-30 mt-4 space-y-2 rounded-xl border-2 border-line bg-bg-surface p-3 shadow-hard"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p role="status" aria-live="polite" className="mr-auto text-caption font-semibold text-text">
          {count} selected
        </p>
        <Button variant="ghost" size="sm" onClick={count === pageCount ? onClear : onSelectAll} disabled={busy || pageCount === 0}>
          {count === pageCount && count > 0 ? "Clear selection" : "Select all on page"}
        </Button>
        <Button variant="ghost" size="sm" iconLeft={<X className="h-4 w-4" aria-hidden />} onClick={onDone} disabled={busy}>
          Done
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" iconLeft={<Tag className="h-4 w-4" aria-hidden />} aria-expanded={tagging} onClick={() => setTagging(!tagging)} disabled={none}>Tags…</Button>
        <Button variant="secondary" size="sm" iconLeft={<Dices className="h-4 w-4" aria-hidden />} onClick={() => onAction("randomizer")} disabled={none}>Add to randomizer</Button>
        <Button variant="secondary" size="sm" iconLeft={<Globe className="h-4 w-4" aria-hidden />} onClick={() => onAction("publish")} disabled={none}>Publish</Button>
        <Button variant="secondary" size="sm" iconLeft={<GlobeLock className="h-4 w-4" aria-hidden />} onClick={() => onAction("unpublish")} disabled={none}>Unpublish</Button>
        <Button variant="secondary" size="sm" iconLeft={<Download className="h-4 w-4" aria-hidden />} onClick={() => onAction("export")} disabled={none}>Export</Button>
        <Button variant="danger" size="sm" iconLeft={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => onAction("delete")} disabled={none}>Delete</Button>
      </div>
      {tagging ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor={tagId} className="mb-1 block text-caption text-text-muted">Tag</label>
            <Input
              id={tagId}
              value={tag}
              maxLength={TAG_MAX_LENGTH}
              onChange={(event) => setTag(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") applyTag("add"); }}
              placeholder="e.g. cheese"
            />
          </div>
          <Button size="sm" onClick={() => applyTag("add")} disabled={!tag.trim() || busy}>Add to {count}</Button>
          <Button variant="ghost" size="sm" onClick={() => applyTag("remove")} disabled={!tag.trim() || busy}>Remove from {count}</Button>
        </div>
      ) : null}
    </section>
  );
}
