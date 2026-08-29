"use client";

import { useState } from "react";
import { MapPin, Plus, Star, X } from "lucide-react";
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
  isProxyStructureToken,
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
  { type: "not_before", label: "✗ Not built before" },
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
            title={
              b.type === "not_before"
                ? "Match only replays where this event does not happen before the selected time."
                : undefined
            }
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
        <button
          type="button"
          onClick={() => addCustomRule("before", { proxyOnly: true })}
          disabled={ruleCap}
          title="Add a building rule that only matches when the structure is more than 50 world units from its owner's main."
          className={[
            "inline-flex min-h-[32px] items-center gap-1 rounded-md border border-warning/50",
            "bg-warning/15 px-2 py-1 text-caption font-medium text-warning transition-colors",
            "hover:bg-warning/25 disabled:cursor-not-allowed disabled:opacity-50",
          ].join(" ")}
        >
          <MapPin className="h-3.5 w-3.5" aria-hidden />
          Proxy building
        </button>
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
        <span className="text-micro font-semibold uppercase tracking-wider text-text-muted">
          Source replay timeline ({rows.length})
        </span>
        <span
          className="inline-flex items-center gap-1 rounded-full border border-accent-cyan/40 bg-accent-cyan/10 px-2 py-0.5 text-micro font-semibold text-accent-cyan"
          title="Tech-defining events are the strongest signal of a build's identity. Adding them as rules gives the cleanest matches."
        >
          <Star
            className="h-3 w-3 fill-accent-cyan text-accent-cyan"
            aria-hidden="true"
          />
          Tech-defining — good to add
        </span>
      </div>
      <div className="max-h-[260px] overflow-y-auto sm:max-h-[420px] lg:max-h-[60vh]">
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
                  <span className="hidden text-micro text-text-dim sm:inline">
                    {r.what}
                  </span>
                  {r.isProxy ? (
                    <span className="rounded border border-warning/50 bg-warning/10 px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wide text-warning">
                      Proxy
                    </span>
                  ) : null}
                  {inRules ? (
                    <span className="text-micro font-semibold text-accent-cyan">
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
                          is_proxy: r.isProxy,
                          race: r.race,
                          category: r.category,
                        })
                      }
                      disabled={ruleCap}
                      title="Add as a rule"
                      aria-label={`Add ${r.what} as a rule`}
                      className="inline-flex h-6 min-w-[44px] items-center justify-center rounded-md bg-accent px-2 text-micro font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
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
      <div className="sticky top-0 border-b border-border bg-bg-subtle/90 px-3 py-1.5 text-micro font-semibold uppercase tracking-wider text-text-muted backdrop-blur">
        Your rules ({rules.length})
        <span className="ml-2 font-normal normal-case text-text-dim">
          · click ⚙ to cycle type · click time to edit
        </span>
      </div>
      <div className="max-h-[260px] overflow-y-auto sm:max-h-[420px] lg:max-h-[60vh]">
        {rules.length === 0 ? (
          <p className="px-3 py-6 text-caption text-text-dim">
            No rules yet. Click + on a ★ tech-defining event in the left
            column, or add a custom rule below. “Not built before” means the
            event must not happen earlier than the selected time; it may happen
            at or after that time.
          </p>
        ) : (
          <ul role="list" className="divide-y divide-border">
            {rules.map((r, idx) => (
              <RuleRow
                key={idx}
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
  const proxyEligible = isProxyStructureToken(rule.name);
  return (
    <li className="space-y-1.5 px-3 py-2 text-caption">
      <div className="flex min-w-0 items-center gap-2">
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
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${rule.name}`}
          className="px-1 text-text-dim hover:text-danger"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <label
          className={[
            "inline-flex min-h-[28px] shrink-0 items-center gap-1.5 rounded-md border px-2 py-1",
            proxyEligible || rule.proxy === true
              ? "cursor-pointer"
              : "cursor-not-allowed opacity-55",
            rule.proxy === true
              ? "border-warning/50 bg-warning/15 text-warning"
              : "border-border bg-bg-elevated text-text-muted",
          ].join(" ")}
          title={
            proxyEligible
              ? "Require this structure to be more than 50 world units from its owner's main."
              : rule.proxy === true
                ? "Enter a known building token such as BuildPylon or turn this requirement off before saving."
                : "Proxy requirements are available only for known building tokens such as BuildPylon or BuildBarracks."
          }
        >
          <input
            type="checkbox"
            checked={rule.proxy === true}
            disabled={!proxyEligible && rule.proxy !== true}
            onChange={(e) => onUpdate({ proxy: e.target.checked })}
            aria-label={`Require ${rule.name || "this structure"} to be proxied`}
            className="h-3.5 w-3.5 accent-[var(--accent)]"
          />
          <MapPin className="h-3.5 w-3.5" aria-hidden />
          <span className="font-medium">Must be proxied</span>
        </label>
        {isCount ? (
          <span className="text-micro text-text-dim">by</span>
        ) : rule.type === "not_before" ? (
          <span className="text-micro text-text-dim">
            <span className="sm:hidden">not before</span>
            <span className="hidden sm:inline">must not be built before</span>
          </span>
        ) : (
          <span className="text-micro text-text-dim">
            <span className="sm:hidden">by</span>
            <span className="hidden sm:inline">must be built by</span>
          </span>
        )}
        <TimeField
          valueSec={rule.time_lt}
          onChange={(next) => onUpdate({ time_lt: next })}
          notBefore={rule.type === "not_before"}
        />
      </div>
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
  const tooltip = `Click to change rule type. Current rule: ${label || rule.type}.`;
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
      aria-label={`Change rule type. Current rule: ${label}`}
      className={[
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium",
        TONE_BADGE_CLASSES[tone],
      ].join(" ")}
    >
      <span className="font-semibold leading-none">{icon}</span>
      <span className="sr-only">{label}</span>
    </button>
  );
}

function TimeField({
  valueSec,
  onChange,
  notBefore = false,
}: {
  valueSec: number;
  onChange: (nextSec: number) => void;
  notBefore?: boolean;
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
        title={
          notBefore
            ? "Earliest allowed time. Click to edit (type 3:30 or 210)."
            : "Deadline. Click to edit (type 3:30 or 210)."
        }
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
      aria-label={notBefore ? "Earliest allowed time" : "Rule deadline"}
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
