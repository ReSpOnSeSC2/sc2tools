"use client";

import { useId, useState } from "react";
import { Lock, Plus, X } from "lucide-react";
import { canonicalTag, isPrivateTag, NOTE_TAG_MAX_LENGTH, NOTE_TAGS_MAX, normalizeTagList, PRESET_TAGS } from "@/lib/notes";

type TagEditorProps = {
  tags: string[];
  onChange: (tags: string[]) => void;
  /** Visible group label, e.g. "Tags" or "Review tags". */
  label?: string;
  max?: number;
  /** Deterministic suggestions shown first (never applied automatically). */
  suggestions?: readonly string[];
  /** Quick-add chips; defaults to the preset note tags. */
  presets?: readonly string[];
  disabled?: boolean;
  /** Explains a suggestion, e.g. "From your games". */
  suggestionHint?: string;
};

const CHIP = "inline-flex min-h-11 items-center gap-1 rounded-full border px-3 text-caption font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * Accessible tag chips: remove buttons on each tag, a text field that adds
 * on Enter, and quick-add buttons for presets and suggestions. Private tags
 * (Toxic) carry a lock and say so to screen readers.
 */
export function TagEditor({
  tags,
  onChange,
  label = "Tags",
  max = NOTE_TAGS_MAX,
  suggestions = [],
  presets = PRESET_TAGS,
  disabled = false,
  suggestionHint,
}: TagEditorProps) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const full = tags.length >= max;
  const has = (tag: string) => tags.some((value) => value.toLowerCase() === tag.toLowerCase());
  const add = (raw: string) => {
    const tag = canonicalTag(raw);
    if (!tag || has(tag) || full) return;
    onChange(normalizeTagList([...tags, tag], max));
    setDraft("");
  };
  const suggested = suggestions.filter((tag) => !has(tag));
  const quick = presets.filter((tag) => !has(tag) && !suggested.some((value) => value.toLowerCase() === tag.toLowerCase()));
  return (
    <fieldset className="min-w-0 space-y-2" disabled={disabled}>
      <legend className="text-caption font-semibold text-text">{label} <span className="font-normal text-text-dim">({tags.length}/{max})</span></legend>
      {tags.length ? (
        <ul className="flex flex-wrap gap-2" aria-label={`${label} on this note`}>
          {tags.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                className={`${CHIP} border-accent/40 bg-accent/10 text-text`}
                aria-label={`Remove tag ${tag}${isPrivateTag(tag) ? " (always private)" : ""}`}
                onClick={() => onChange(tags.filter((value) => value !== tag))}
              >
                {isPrivateTag(tag) ? <Lock className="h-3.5 w-3.5" aria-hidden /> : null}
                {tag}
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {suggested.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption text-text-muted">{suggestionHint || "Suggested"}:</span>
          {suggested.map((tag) => (
            <button key={tag} type="button" disabled={full} onClick={() => add(tag)} className={`${CHIP} border-warning/50 bg-warning/10 text-text disabled:opacity-50`} aria-label={`Add suggested tag ${tag}`}>
              <Plus className="h-3.5 w-3.5" aria-hidden />{tag}
            </button>
          ))}
        </div>
      ) : null}
      {quick.length ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label={`Add a preset ${label.toLowerCase()}`}>
          {quick.map((tag) => (
            <button key={tag} type="button" disabled={full} onClick={() => add(tag)} className={`${CHIP} border-border bg-bg-elevated text-text-muted hover:text-text disabled:opacity-50`} aria-label={`Add tag ${tag}${isPrivateTag(tag) ? " (always private)" : ""}`}>
              {isPrivateTag(tag) ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}{tag}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-tag`} className="sr-only">New {label.toLowerCase()}</label>
        <input
          id={`${id}-tag`}
          value={draft}
          maxLength={NOTE_TAG_MAX_LENGTH}
          disabled={disabled || full}
          placeholder={full ? `Up to ${max} tags` : "Add your own tag"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(draft); } }}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-body text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 sm:max-w-xs"
        />
        <button type="button" disabled={disabled || full || !canonicalTag(draft)} onClick={() => add(draft)} className={`${CHIP} border-border bg-bg-elevated text-text disabled:opacity-50`}>
          <Plus className="h-3.5 w-3.5" aria-hidden />Add tag
        </button>
      </div>
    </fieldset>
  );
}
