"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Toggle";
import { Icon } from "@/components/ui/Icon";
import {
  DESC_MAX_CHARS,
  NAME_MAX_CHARS,
  RACE_OPTIONS,
  SKILL_LEVELS,
  STRATEGY_NOTE_MAX_CHARS,
  STRATEGY_NOTE_MAX_ITEMS,
  VS_RACE_OPTIONS,
  type RaceLite,
  type SkillLevelId,
  type VsRaceLite,
} from "@/lib/build-rules";
import type { BuildEditorBasicsProps } from "./BuildEditor.types";

/**
 * BuildEditorBasics — Section 1 of the BuildEditor modal.
 *
 * Renders the core metadata: name, recommended-for skill level, race,
 * vsRace, description (with live char count), share-with-community
 * toggle, and the collapsible strategy notes section (chips lists).
 */
export function BuildEditorBasics({
  draft,
  setDraft,
  errors,
}: BuildEditorBasicsProps) {
  const [showStrategyNotes, setShowStrategyNotes] = useState(false);

  return (
    <section aria-label="Basics" className="space-y-2.5">
      <h3 className="text-caption font-semibold uppercase tracking-wider text-text-muted">
        1 · Basics
      </h3>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Name" required error={errors.name}>
          <Input
            value={draft.name}
            maxLength={NAME_MAX_CHARS}
            onChange={(e) =>
              setDraft((d) => ({ ...d, name: e.target.value }))
            }
            placeholder="e.g. PvT — 1-Gate Expand into Stargate"
            autoFocus
          />
        </Field>

        <Field label="Recommended for">
          <SkillLevelSelect
            value={draft.skillLevel}
            onChange={(next) => setDraft((d) => ({ ...d, skillLevel: next }))}
          />
        </Field>

        <Field label="Race">
          <Select
            value={draft.race}
            onChange={(e) =>
              setDraft((d) => ({ ...d, race: e.target.value as RaceLite }))
            }
          >
            {RACE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Vs race">
          <Select
            value={draft.vsRace}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                vsRace: e.target.value as VsRaceLite,
              }))
            }
          >
            {VS_RACE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label={`Description (${draft.description.length}/${DESC_MAX_CHARS})`}
      >
        <textarea
          className="block w-full resize-none rounded-lg border border-border bg-bg-elevated px-3 py-1.5 text-body text-text placeholder:text-text-dim focus:border-accent-cyan focus:outline-none focus:ring-1 focus:ring-accent-cyan"
          rows={2}
          maxLength={DESC_MAX_CHARS}
          value={draft.description}
          onChange={(e) =>
            setDraft((d) => ({ ...d, description: e.target.value }))
          }
          placeholder="What this build is for, when to use it, key timings…"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2">
          <Toggle
            checked={draft.shareWithCommunity}
            onChange={(next) =>
              setDraft((d) => ({ ...d, shareWithCommunity: next }))
            }
            aria-label="Share with community"
          />
          <span className="text-caption text-text">
            <span className="block font-medium">Share with community</span>
            <span className="block text-text-dim">Visible to all players</span>
          </span>
        </label>

        <button
          type="button"
          onClick={() => setShowStrategyNotes((v) => !v)}
          aria-expanded={showStrategyNotes}
          className="ml-auto inline-flex items-center gap-1 text-caption text-text-muted hover:text-text"
        >
          {showStrategyNotes ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          )}
          Strategy notes (optional)
        </button>
      </div>

      {showStrategyNotes ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <ChipsField
            label="Win conditions"
            values={draft.winConditions}
            onChange={(next) =>
              setDraft((d) => ({ ...d, winConditions: next }))
            }
          />
          <ChipsField
            label="Loses to"
            values={draft.losesTo}
            onChange={(next) => setDraft((d) => ({ ...d, losesTo: next }))}
          />
          <ChipsField
            label="Transitions into"
            values={draft.transitionsInto}
            onChange={(next) =>
              setDraft((d) => ({ ...d, transitionsInto: next }))
            }
          />
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* SkillLevelSelect — image-augmented select                          */
/* ------------------------------------------------------------------ */

function SkillLevelSelect({
  value,
  onChange,
}: {
  value: SkillLevelId | null;
  onChange: (next: SkillLevelId | null) => void;
}) {
  return (
    <div className="relative flex items-center gap-2">
      {value ? (
        <Icon
          name={value}
          kind="league"
          size="sm"
          decorative
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
        />
      ) : null}
      <Select
        value={value ?? ""}
        onChange={(e) =>
          onChange(
            e.target.value
              ? (e.target.value as SkillLevelId)
              : null,
          )
        }
        className={value ? "pl-9" : undefined}
      >
        <option value="">— none —</option>
        {SKILL_LEVELS.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ChipsField — strategy-note tag list                                */
/* ------------------------------------------------------------------ */

function ChipsField({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const canAdd = values.length < STRATEGY_NOTE_MAX_ITEMS;

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (values.includes(trimmed)) {
      setDraft("");
      return;
    }
    onChange([...values, trimmed.slice(0, STRATEGY_NOTE_MAX_CHARS)]);
    setDraft("");
  }

  function remove(item: string) {
    onChange(values.filter((v) => v !== item));
  }

  return (
    <div className="space-y-1.5">
      <label className="text-caption font-medium text-text">{label}</label>
      <div
        className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-bg-elevated px-2 py-1.5 focus-within:border-accent-cyan"
        role="group"
        aria-label={label}
      >
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-md border border-border-strong bg-bg-subtle px-1.5 py-0.5 text-caption text-text"
          >
            {v}
            <button
              type="button"
              aria-label={`Remove ${v}`}
              onClick={() => remove(v)}
              className="text-text-dim hover:text-danger"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        ))}
        {canAdd ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Backspace" && !draft && values.length) {
                onChange(values.slice(0, -1));
              }
            }}
            onBlur={commit}
            placeholder="+ add"
            maxLength={STRATEGY_NOTE_MAX_CHARS}
            className="min-w-[80px] flex-1 bg-transparent text-body text-text placeholder:text-text-dim focus:outline-none"
            aria-label={`Add to ${label}`}
          />
        ) : null}
      </div>
    </div>
  );
}
