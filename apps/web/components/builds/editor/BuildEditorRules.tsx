"use client";

import { useState } from "react";
import { Plus, Star, X } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import {
  RULE_TYPES,
  RULE_TYPE_ICON,
  RULE_TYPE_LABEL,
  RULE_TYPE_TONE,
  RULES_MAX_PER_BUILD,
  clampCount,
  clampRuleTime,
  formatTime,
  isCountRule,
  parseTimeInput,
  type BuildRule,
  type RuleType,
} from "@/lib/build-rules";
import type { BuildEditorRulesProps } from "./BuildEditor.types";

const TONE_BTN_CLASSES: Record<"win" | "loss" | "neutral", string> = {
  win:
    "bg-success/15 text-success border border-success/40 hover:bg-success/25",
  loss:
    "bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25",
  neutral:
    "bg-bg-subtle text-text border border-border hover:bg-bg-elevated",
};

const TONE_BADGE_CLASSES: Record<"win" | "loss" | "neutral", string> = {
  win: "bg-success/15 text-success border-success/40",
  loss: "bg-danger/15 text-danger border-danger/40",
  neutral: "bg-bg-subtle text-text border-border-strong",
};

const CUSTOM_RULE_BUTTONS: Array<{
  type: RuleType;
  label: string;
}> = [
  { type: "before", label: "✓ built by" },
  { type: "not_before", label: "✗ NOT by" },
  { type: "count_max", label: "≤ count" },
  { type: "count_exact", label: "= count" },
  { type: "count_min", label: "≥ count" },
];

/**
 * BuildEditorRules — Section 2 of the BuildEditor.
 *
 * Left column: source replay timeline (one row per parseable event)
 * with a [+] button to promote the event to a rule. Tech-defining
 * tokens get a star + accent background to nudge the user toward the
 * events worth tracking.
 *
 * Right column: the user's rule list with cycle-type, edit-time, edit-
 * count, remove. The save bar in the parent shows whether any rules
 * have been added (no rules → save disabled).
 *
 * Below: custom rule pickers — one button per rule type so the user
 * can add a rule even when the source timeline is empty.
 */
export function BuildEditorRules({
  draft,
  errors,
  sourceRows,
  updateRule,
  removeRule,
  cycleRule,
  addRuleFromEvent,
  addCustomRule,
}: BuildEditorRulesProps) {
  const inUseNames = new Set(draft.rules.map((r) => r.name));
  const ruleCap = draft.rules.length >= RULES_MAX_PER_BUILD;
  return (
    <section aria-label="Match rules" className="space-y-2">
      <h3 className="text-caption font-semibold uppercase tracking-wider text-text-muted">
        2 · Match rules{" "}
        <span className="font-normal normal-case text-text-dim">
          ({draft.rules.length}/{RULES_MAX_PER_BUILD} · ALL must pass)
        </span>
      </h3>
      {errors.rules ? (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-caption text-danger"
        >
          {errors.rules}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SourceTimelinePanel
          rows={sourceRows}
          inUseNames={inUseNames}
          onAdd={addRuleFromEvent}
          ruleCap={ruleCap}
        />
        <RulesListPanel
          rules={draft.rules}
          updateRule={updateRule}
          removeRule={removeRule}
          cycleRule={cycleRule}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-caption text-text-muted">
        <span>Add custom rule:</span>
        {CUSTOM_RULE_BUTTONS.map((b) => (
          <button
            key={b.type}
            type="button"
            onClick={() => addCustomRule(b.type)}
            disabled={ruleCap}
            className={[
              "rounded-md px-2 py-1 text-caption font-medium transition-colors",
              "disabled:cursor-not-allowed disabled:opacity-50",
              "min-h-[32px]",
              TONE_BTN_CLASSES[RULE_TYPE_TONE[b.type]],
            ].join(" ")}
          >
            {b.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Source timeline (left)                                             */
/* ------------------------------------------------------------------ */

interface SourceTimelinePanelProps {
  rows: BuildEditorRulesProps["sourceRows"];
  inUseNames: ReadonlySet<string>;
  onAdd: BuildEditorRulesProps["addRuleFromEvent"];
  ruleCap: boolean;
}

function SourceTimelinePanel({
  rows,
  inUseNames,
  onAdd,
  ruleCap,
}: SourceTimelinePanelProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-bg-subtle/50">
      <div className="sticky top-0 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-bg-subtle/90 px-3 py-1.5 backdrop-blur">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          Source replay timeline ({rows.length})
        </span>
        <span
          className="inline-flex items-center gap-1 rounded-full border border-accent-cyan/40 bg-accent-cyan/10 px-2 py-0.5 text-[10px] font-semibold text-accent-cyan"
          title="Tech-defining events are the strongest signal of a build's identity. Adding them as rules gives the cleanest matches."
        >
          <Star
            className="h-3 w-3 fill-accent-cyan text-accent-cyan"
            aria-hidden="true"
          />
          Tech-defining — good to add
        </span>
      </div>
      <div className="max-h-[260px] overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-caption text-text-dim">
            No mappable events on this game.
          </p>
        ) : (
          <ul role="list" className="divide-y divide-border">
            {rows.map((r) => {
              const inRules = inUseNames.has(r.what);
              const rowAccent = r.isTech
                ? "bg-accent-cyan/10 border-l-2 border-accent-cyan"
                : "border-l-2 border-transparent opacity-80 hover:opacity-100";
              return (
                <li
                  key={r.key}
                  className={`flex items-center gap-2 px-3 py-1.5 text-caption ${rowAccent}`}
                >
                  <span className="w-10 font-mono tabular-nums text-text-dim">
                    {r.timeDisplay}
                  </span>
                  <span className="flex w-4 items-center justify-center">
                    {r.isTech ? (
                      <Star
                        className="h-3.5 w-3.5 fill-accent-cyan text-accent-cyan drop-shadow-[0_0_4px_rgba(62,192,199,0.55)]"
                        aria-label="Tech-defining event"
                      />
                    ) : null}
                  </span>
                  <Icon
                    name={r.what.replace(/^(Build|Train|Research|Morph)/, "")}
                    decorative
                    size="sm"
                    className="flex-shrink-0"
                  />
                  <span
                    className={`flex-1 truncate ${r.isTech ? "font-semibold text-text" : "text-text"}`}
                    title={r.what}
                  >
                    {r.display}
                  </span>
                  <span className="hidden text-[10px] text-text-dim sm:inline">
                    {r.what}
                  </span>
                  {inRules ? (
                    <span className="text-[10px] font-semibold text-accent-cyan">
                      ✓ in rules
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        onAdd({
                          time: r.t,
                          name: r.what,
                          is_building: r.isBuilding,
                          race: r.race,
                          category: r.category,
                        })
                      }
                      disabled={ruleCap}
                      title="Add as a rule"
                      aria-label={`Add ${r.what} as a rule`}
                      className="inline-flex h-6 min-w-[44px] items-center justify-center rounded-md bg-accent px-2 text-[10px] font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Plus className="h-3 w-3" aria-hidden />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rules list (right)                                                 */
/* ------------------------------------------------------------------ */

interface RulesListPanelProps {
  rules: ReadonlyArray<BuildRule>;
  updateRule: BuildEditorRulesProps["updateRule"];
  removeRule: BuildEditorRulesProps["removeRule"];
  cycleRule: BuildEditorRulesProps["cycleRule"];
}

function RulesListPanel({
  rules,
  updateRule,
  removeRule,
  cycleRule,
}: RulesListPanelProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-bg-subtle/50">
      <div className="sticky top-0 border-b border-border bg-bg-subtle/90 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted backdrop-blur">
        Your rules ({rules.length})
        <span className="ml-2 font-normal normal-case text-text-dim">
          · click ⚙ to cycle type · click time to edit
        </span>
      </div>
      <div className="max-h-[260px] overflow-y-auto">
        {rules.length === 0 ? (
          <p className="px-3 py-6 text-caption text-text-dim">
            No rules yet. Click + on a ★ tech-defining event in the left
            column, or use the ✓ / ✗ / ≤ / ≥ buttons below to add a
            custom rule.
          </p>
        ) : (
          <ul role="list" className="divide-y divide-border">
            {rules.map((r, idx) => (
              <RuleRow
                key={`${r.name}-${idx}`}
                rule={r}
                onUpdate={(patch) => updateRule(idx, patch)}
                onCycle={() => cycleRule(idx)}
                onRemove={() => removeRule(idx)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* RuleRow — one row in the rules-list column                         */
/* ------------------------------------------------------------------ */

interface RuleRowProps {
  rule: BuildRule;
  onUpdate: (patch: Partial<BuildRule>) => void;
  onCycle: () => void;
  onRemove: () => void;
}

function RuleRow({ rule, onUpdate, onCycle, onRemove }: RuleRowProps) {
  const tone = RULE_TYPE_TONE[rule.type];
  const isCount = isCountRule(rule);
  return (
    <li className="flex items-center gap-2 px-3 py-1.5 text-caption">
      <CycleBadge
        rule={rule}
        tone={tone}
        isCount={isCount}
        onCycle={onCycle}
        onCountChange={(next) => onUpdate({ count: next })}
      />
      <input
        type="text"
        value={rule.name}
        placeholder="BuildStargate"
        title="Event token (e.g. BuildStargate, ResearchBlink)"
        onChange={(e) => onUpdate({ name: e.target.value.trim() })}
        className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-caption text-text placeholder:text-text-dim focus:border-border-strong focus:outline-none"
      />
      <span className="text-[10px] text-text-dim">by</span>
      <TimeField
        valueSec={rule.time_lt}
        onChange={(next) => onUpdate({ time_lt: next })}
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${rule.name}`}
        className="px-1 text-text-dim hover:text-danger"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* CycleBadge / TimeField                                             */
/* ------------------------------------------------------------------ */

function CycleBadge({
  rule,
  tone,
  isCount,
  onCycle,
  onCountChange,
}: {
  rule: BuildRule;
  tone: "win" | "loss" | "neutral";
  isCount: boolean;
  onCycle: () => void;
  onCountChange: (next: number) => void;
}) {
  const icon = RULE_TYPE_ICON[rule.type];
  const label = RULE_TYPE_LABEL[rule.type];
  const tooltip = `Click to cycle rule type (currently: ${rule.type.replace("_", " ")})`;
  if (isCount) {
    const minCount = rule.type === "count_min" ? 1 : 0;
    return (
      <span
        title={tooltip}
        className={[
          "inline-flex items-center gap-1 rounded border px-1.5 py-0.5",
          TONE_BADGE_CLASSES[tone],
        ].join(" ")}
      >
        <button
          type="button"
          onClick={onCycle}
          aria-label={`Cycle rule type from ${rule.type}`}
          className="font-semibold leading-none"
        >
          {icon}
        </button>
        <input
          type="number"
          min={minCount}
          max={200}
          step={1}
          value={isCount ? (rule as { count: number }).count : 0}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (!Number.isNaN(n)) {
              onCountChange(Math.max(minCount, clampCount(n)));
            }
          }}
          onWheel={(e) => {
            e.preventDefault();
            const delta = e.deltaY < 0 ? 1 : -1;
            const cur = isCount ? (rule as { count: number }).count : 0;
            onCountChange(Math.max(minCount, clampCount(cur + delta)));
          }}
          aria-label={`Count for ${rule.name}`}
          className="w-12 rounded border border-accent-cyan/50 bg-bg-elevated/50 px-1 text-center font-mono text-caption tabular-nums text-text focus:border-accent-cyan focus:outline-none"
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onCycle}
      title={tooltip}
      aria-label="Cycle rule type"
      className={[
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium",
        TONE_BADGE_CLASSES[tone],
      ].join(" ")}
    >
      <span className="font-semibold leading-none">{icon}</span>
      <span className="text-[10px]">{label}</span>
    </button>
  );
}

function TimeField({
  valueSec,
  onChange,
}: {
  valueSec: number;
  onChange: (nextSec: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatTime(valueSec));

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(formatTime(valueSec));
          setEditing(true);
        }}
        className="font-mono text-caption tabular-nums text-accent-cyan underline decoration-dotted underline-offset-2 hover:text-accent"
        title="Click to edit (type 3:30 or 210)"
      >
        {formatTime(valueSec)}
      </button>
    );
  }

  function commit() {
    const parsed = parseTimeInput(draft);
    if (parsed != null) onChange(clampRuleTime(parsed));
    setEditing(false);
  }

  return (
    <input
      type="text"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          setEditing(false);
        }
      }}
      onWheel={(e) => {
        e.preventDefault();
        const cur = parseTimeInput(draft);
        if (cur != null) {
          const next = clampRuleTime(cur + (e.deltaY < 0 ? 5 : -5));
          setDraft(formatTime(next));
          onChange(next);
        }
      }}
      className="w-16 rounded border border-accent-cyan bg-bg-elevated px-1 font-mono text-caption tabular-nums text-text focus:outline-none"
    />
  );
}

// `RULE_TYPES` is exported from build-rules but not used directly in
// this file; importing it here keeps the type narrowing live for the
// CUSTOM_RULE_BUTTONS array literal type.
void RULE_TYPES;
