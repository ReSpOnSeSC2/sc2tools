"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MapPin, X } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { Select } from "@/components/ui/Select";
import {
  COUNT_MAX,
  PROXY_RULE_DISTANCE_HINT,
  clampRuleTime,
  formatTime,
  isProxyStructureToken,
  parseTimeInput,
  type BuildRule,
} from "@/lib/build-rules";
import {
  RULE_QUANTIFIERS,
  RULE_TONE_STRIPE,
  ruleCountValue,
  ruleQuantifier,
  ruleTone,
  type RuleQuantifier,
} from "@/lib/build-rules-quantity";
import {
  describeRule,
  humanizeRuleEntity,
  pluralizeEntity,
  ruleReadout,
  type RuleContext,
  type RuleReadoutTone,
} from "@/lib/build-rules-copy";

/** Same token shape sanitiseRule keeps; only these get an entity icon. */
const RULE_TOKEN_RE = /^[A-Za-z][A-Za-z0-9]*$/;

const COUNT_TIME_TITLE =
  "Only what starts before this game time counts. Click to change (type 3:30 or 210).";
const NONE_TIME_TITLE =
  "Fails if one starts before this game time; at or after it is fine. Click to change (type 3:30 or 210).";

const NOTE_TONE_CLASSES: Record<RuleReadoutTone, string> = {
  dim: "text-text-dim",
  warning: "text-warning",
  danger: "text-danger",
};

export interface RuleRowProps {
  rule: BuildRule;
  /** Zero-based position; the row reads as "Rule {index + 1}". */
  index: number;
  /** ruleContexts(rules)[index], for "in total" and the deadline note. */
  ctx: RuleContext;
  /** Name, time or proxy edits (BuildEditorState.updateRule). */
  onUpdate: (patch: Partial<BuildRule>) => void;
  /** Picker change. `carry` is the row's last number, for None → a count. */
  onQuantity: (q: RuleQuantifier, carry: number) => void;
  /** A typed number (BuildEditorState.setRuleCount). */
  onCount: (n: number) => void;
  onRemove: () => void;
  /** Focus the token input on mount (a rule just added from the add bar). */
  autoFocusName?: boolean;
}

/**
 * RuleRow — one rule in plain words, on three lines:
 *   1. what: entity icon, token input, remove;
 *   2. how many and when: "At least [1] before [6:40]" plus the proxy chip;
 *   3. the read-back sentence, which also labels the row for screen
 *      readers ("Rule 1: Passes with 1 or more Void Rays started before
 *      6:40 — one is enough.").
 * The stripe colour follows ruleTone; the words carry the meaning.
 */
export function RuleRow({
  rule,
  index,
  ctx,
  onUpdate,
  onQuantity,
  onCount,
  onRemove,
  autoFocusName = false,
}: RuleRowProps) {
  const id = useId();
  const readoutId = `${id}-readout`;
  const quantifier = ruleQuantifier(rule);
  const count = ruleCountValue(rule);
  // None has no number; picking a count again brings the last one back.
  const lastCountRef = useRef(1);
  useEffect(() => {
    if (count !== null) lastCountRef.current = count;
  }, [count]);

  return (
    // Row separators sit on the <li> (not the list's divide-*), because a
    // divide colour would override the stripe's left-border colour.
    <li
      className={`border-l-2 ${RULE_TONE_STRIPE[ruleTone(rule)]} border-t border-t-border px-3 py-2 text-caption first:border-t-0`}
    >
      <div
        role="group"
        aria-labelledby={`${id}-n ${readoutId}`}
        className="space-y-1.5"
      >
        <RuleSubject
          rule={rule}
          index={index}
          labelId={`${id}-n`}
          autoFocus={autoFocusName}
          onUpdate={onUpdate}
          onRemove={onRemove}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <QuantityPicker
            value={quantifier}
            describedBy={readoutId}
            onChange={(q) => onQuantity(q, lastCountRef.current)}
          />
          {count !== null ? (
            <CountField
              value={count}
              min={quantifier === "at_least" ? 1 : 0}
              describedBy={readoutId}
              onCommit={onCount}
            />
          ) : null}
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-micro text-text-dim">before</span>
            <TimeField
              valueSec={rule.time_lt}
              none={quantifier === "none"}
              onChange={(next) => onUpdate({ time_lt: next })}
            />
          </span>
          <ProxyToggle rule={rule} onChange={(proxy) => onUpdate({ proxy })} />
        </div>
        <RuleReadout id={readoutId} rule={rule} ctx={ctx} />
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Line 1: entity, token input, remove                                */
/* ------------------------------------------------------------------ */

function RuleSubject({
  rule,
  index,
  labelId,
  autoFocus,
  onUpdate,
  onRemove,
}: {
  rule: BuildRule;
  index: number;
  /** Id of the "Rule N:" label the row's group is named by. */
  labelId: string;
  autoFocus: boolean;
  onUpdate: RuleRowProps["onUpdate"];
  onRemove: RuleRowProps["onRemove"];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* Here, not first in the group, where space-y would push line 1 down. */}
      <span id={labelId} className="sr-only">
        Rule {index + 1}:
      </span>
      {RULE_TOKEN_RE.test(rule.name) ? (
        <Icon
          name={rule.name.replace(/^(Build|Train|Research|Morph)/, "")}
          decorative
          size="sm"
          className="flex-shrink-0"
        />
      ) : null}
      <input
        ref={inputRef}
        type="text"
        value={rule.name}
        placeholder="BuildStargate"
        title="Event token (e.g. BuildStargate, ResearchBlink)"
        aria-label="Unit, building or upgrade"
        onChange={(e) => onUpdate({ name: e.target.value.trim() })}
        className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-caption text-text placeholder:text-text-dim focus:border-border-strong focus:outline-none"
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove rule ${index + 1}: ${describeRule(rule)}`}
        title="Remove rule"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-dim transition-colors hover:text-danger"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Line 2: quantity, count, time, proxy                               */
/* ------------------------------------------------------------------ */

function QuantityPicker({
  value,
  describedBy,
  onChange,
}: {
  value: RuleQuantifier;
  describedBy: string;
  onChange: (q: RuleQuantifier) => void;
}) {
  return (
    <span className="w-24 shrink-0">
      <Select
        selectSize="sm"
        aria-label="How many"
        aria-describedby={describedBy}
        value={value}
        onChange={(e) => onChange(e.target.value as RuleQuantifier)}
      >
        {RULE_QUANTIFIERS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
    </span>
  );
}

/**
 * The rule's number. Keeps the typed text locally and commits every
 * whole number as it is typed (so the preview follows); blur restores
 * the stored value, which also clears an empty or out-of-range entry.
 * No onWheel: scrolling the panel must never change a count.
 */
function CountField({
  value,
  min,
  describedBy,
  onCommit,
}: {
  value: number;
  min: number;
  describedBy: string;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    // The stored number moved (a commit, a clamp or the picker).
    setShown(value);
    setText(String(value));
  }
  return (
    <input
      type="number"
      inputMode="numeric"
      min={min}
      max={COUNT_MAX}
      step={1}
      value={text}
      aria-label="Count"
      aria-describedby={describedBy}
      onChange={(e) => {
        const raw = e.target.value.trim();
        setText(raw);
        if (/^\d+$/.test(raw)) onCommit(Number(raw));
      }}
      onBlur={() => setText(String(value))}
      className="h-8 w-12 rounded-md border-2 border-line bg-bg-surface px-1 text-center font-mono text-caption tabular-nums text-text focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
    />
  );
}

/**
 * Click-to-edit game time. Enter commits, Escape cancels (both return
 * focus to the time button), blur commits. No onWheel.
 */
function TimeField({
  valueSec,
  none,
  onChange,
}: {
  valueSec: number;
  none: boolean;
  onChange: (nextSec: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const refocusRef = useRef(false);
  useEffect(() => {
    if (editing || !refocusRef.current) return;
    refocusRef.current = false;
    buttonRef.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <TimeEditor
        initial={formatTime(valueSec)}
        onDone={(next, byKey) => {
          if (next != null) onChange(next);
          refocusRef.current = byKey;
          setEditing(false);
        }}
      />
    );
  }
  const time = formatTime(valueSec);
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => setEditing(true)}
      aria-label={`Before ${time}, change time`}
      title={none ? NONE_TIME_TITLE : COUNT_TIME_TITLE}
      className="inline-flex h-8 items-center px-0.5 font-mono text-caption tabular-nums text-accent-cyan underline decoration-dotted underline-offset-2 hover:text-accent"
    >
      {time}
    </button>
  );
}

/** The open time editor. `onDone(seconds | null, byKey)`; null = no change. */
function TimeEditor({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (nextSec: number | null, byKey: boolean) => void;
}) {
  const [draft, setDraft] = useState(initial);
  // Escape closes without committing, even if the unmount blurs the input.
  const doneRef = useRef(false);
  const finish = (commit: boolean, byKey: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const parsed = commit ? parseTimeInput(draft) : null;
    onDone(parsed == null ? null : clampRuleTime(parsed), byKey);
  };
  return (
    <input
      type="text"
      autoFocus
      value={draft}
      aria-label="Before (game time, m:ss)"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true, false)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true, true);
        } else if (e.key === "Escape") {
          // Cancel only this edit; the modal closes on Escape at document.
          e.stopPropagation();
          finish(false, true);
        }
      }}
      className="h-8 w-16 rounded border border-accent-cyan bg-bg-elevated px-1 font-mono text-caption tabular-nums text-text focus:outline-none"
    />
  );
}

/**
 * "Only count proxied" chip: shown for proxy-eligible buildings, and
 * whenever proxy is already on so an invalid state can be unticked.
 */
function ProxyToggle({
  rule,
  onChange,
}: {
  rule: BuildRule;
  onChange: (proxy: boolean) => void;
}) {
  const eligible = isProxyStructureToken(rule.name);
  const on = rule.proxy === true;
  if (!eligible && !on) return null;
  const entities = pluralizeEntity(humanizeRuleEntity(rule.name)) || "buildings";
  return (
    <label
      className={[
        "ml-auto inline-flex min-h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2",
        on
          ? "border-warning/50 bg-warning/15 text-warning"
          : "border-border bg-bg-elevated text-text-muted",
      ].join(" ")}
      title={
        eligible
          ? `Only count ${entities} placed ${PROXY_RULE_DISTANCE_HINT}.`
          : "Only works for buildings. Enter one, such as BuildPylon, or untick this before saving."
      }
    >
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={`Only count proxied ${entities}`}
        className="h-3.5 w-3.5 accent-[var(--accent)]"
      />
      <MapPin className="h-3.5 w-3.5" aria-hidden />
      <span className="font-medium">Only count proxied</span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Line 3: read-back                                                  */
/* ------------------------------------------------------------------ */

function RuleReadout({
  id,
  rule,
  ctx,
}: {
  id: string;
  rule: BuildRule;
  ctx: RuleContext;
}) {
  const r = ruleReadout(rule, ctx);
  return (
    <p id={id} className="text-micro text-text-muted">
      {r.lead}
      {r.strong ? <strong className="font-semibold text-text">{r.strong}</strong> : null}
      {r.rest}
      {r.time ? <span className="font-mono tabular-nums">{r.time}</span> : null}
      <span className={r.noteTone ? NOTE_TONE_CLASSES[r.noteTone] : undefined}>
        {r.note}
      </span>
    </p>
  );
}
