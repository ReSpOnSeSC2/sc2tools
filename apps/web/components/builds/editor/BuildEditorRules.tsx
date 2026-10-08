"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Check, MapPin, Plus, Star } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import {
  AUTO_PICK_TIME_BUFFER_SEC,
  PROXY_RULE_DISTANCE_HINT,
  RULES_MAX_PER_BUILD,
  formatTime,
  ruleFromEvent,
  type BuildRule,
  type RuleType,
  type SourceTimelineRow,
} from "@/lib/build-rules";
import {
  raiseRuleForRepeatRow,
  type RepeatRowRaise,
} from "@/lib/build-rules-repeat";
import {
  describeRule,
  ruleContexts,
  ruleEntity,
} from "@/lib/build-rules-copy";
import {
  RULE_QUANTIFIERS,
  withQuantifier,
  type RuleQuantifier,
} from "@/lib/build-rules-quantity";
import {
  nameCountKey,
  nameCountWarning,
  rulesRequireNothing,
} from "@/lib/build-rules-name-check";
import type { BuildEditorRulesProps } from "./BuildEditor.types";
import { RuleRow } from "./BuildEditorRuleRow";
import {
  NameCountCallout,
  RequireNothingCallout,
  RulesLegend,
} from "./BuildEditorRulesHelp";

const TONE_BTN_CLASSES: Record<"win" | "loss" | "neutral", string> = {
  win:
    "bg-success/15 text-success border border-success/40 hover:bg-success/25",
  loss:
    "bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25",
  neutral:
    "bg-bg-subtle text-text border border-border hover:bg-bg-elevated",
};

const ADD_BUTTON_CLASSES =
  "inline-flex min-h-[32px] items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

/** How long a live-region announcement stays before it is cleared. */
const ANNOUNCE_TTL_MS = 5000;

/**
 * BuildEditorRules — Section 2 of the BuildEditor.
 *
 * Top: the "How rules count" legend and the advisory build-level
 * callouts (rules that require nothing; a build name that asks for more
 * than the rules do). Neither blocks saving.
 *
 * Left column: source replay timeline (one row per parseable event)
 * with a [+] button to promote the event to an "At least 1" rule, or an
 * "At least N" chip on a later row of a token already in the rules.
 * Tech-defining tokens get a star + accent background.
 *
 * Right column: the user's rules, each in plain words (quantity, number,
 * "before" time, proxy chip) with a read-back sentence. The save bar in
 * the parent shows whether any rules have been added.
 *
 * Below: the "Add a rule:" bar, one button per quantity word, so the
 * user can add a rule even when the source timeline is empty.
 *
 * Discrete actions (adds, picker changes, removals) are said back once
 * through a polite live region; typing never is.
 */
export function BuildEditorRules({
  draft,
  errors,
  sourceRows,
  countRepeats = true,
  updateRule,
  removeRule,
  setRuleQuantity,
  setRuleCount,
  addRuleFromEvent,
  addCustomRule,
}: BuildEditorRulesProps) {
  const rules = draft.rules;
  const ruleCap = rules.length >= RULES_MAX_PER_BUILD;
  const [announcement, announce] = useLiveAnnouncement();
  // "Require N" and "Dismiss" unmount their own callout; focus moves to the
  // rules list so keyboard and screen-reader users keep their place.
  const rulesPanelRef = useRef<HTMLDivElement>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Index of a rule just added from the add bar; its token input takes focus.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  useEffect(() => {
    // The new row focused itself on mount (child effects run first).
    if (focusIndex !== null && focusIndex < rules.length) setFocusIndex(null);
  }, [focusIndex, rules.length]);

  const addFromRow = (row: SourceTimelineRow) => {
    const raise = countRepeats
      ? raiseRuleForRepeatRow(rules, sourceRows, row)
      : null;
    const ev = rowEvent(row);
    const text = rowAddAnnouncement(rules, raise, ruleFromEvent(ev));
    addRuleFromEvent(ev);
    if (text) announce(text);
  };

  const addBlank = (type: RuleType, text: string, proxyOnly = false) => {
    if (proxyOnly) addCustomRule(type, { proxyOnly: true });
    else addCustomRule(type);
    setFocusIndex(rules.length);
    announce(text);
  };

  const changeQuantity = (idx: number, q: RuleQuantifier, carry: number) => {
    const rule = rules[idx];
    setRuleQuantity(idx, q, carry);
    const next = rule ? withQuantifier(rule, q, carry) : rule;
    if (next && next !== rule) {
      announce(`Rule ${idx + 1} now: ${describeRule(next)}.`);
    }
  };

  const remove = (idx: number) => {
    const rule = rules[idx];
    removeRule(idx);
    if (rule) announce(`Removed rule ${idx + 1}: ${describeRule(rule)}.`);
  };

  const warning = nameCountWarning(
    draft.name,
    rules,
    sourceRows,
    countRepeats,
    dismissed,
  );

  return (
    <section aria-label="Match rules" className="space-y-2">
      <h3 className="text-caption font-semibold uppercase tracking-wider text-text-muted">
        2 · Match rules{" "}
        <span className="font-normal normal-case text-text-dim">
          ({rules.length}/{RULES_MAX_PER_BUILD} · every rule must pass)
        </span>
      </h3>
      <RulesLegend />
      {errors.rules ? (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-caption text-danger"
        >
          {errors.rules}
        </p>
      ) : null}
      {rulesRequireNothing(rules) ? <RequireNothingCallout /> : null}
      {warning ? (
        <NameCountCallout
          warning={warning}
          onRequire={() => {
            if (warning.nthRow) addFromRow(warning.nthRow);
            rulesPanelRef.current?.focus();
          }}
          onDismiss={() => {
            setDismissed((prev) => new Set(prev).add(nameCountKey(warning)));
            rulesPanelRef.current?.focus();
          }}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SourceTimelinePanel
          rows={sourceRows}
          rules={rules}
          countRepeats={countRepeats}
          ruleCap={ruleCap}
          onAdd={addFromRow}
        />
        <RulesListPanel
          panelRef={rulesPanelRef}
          rules={rules}
          focusIndex={focusIndex}
          onUpdate={updateRule}
          onQuantity={changeQuantity}
          onCount={setRuleCount}
          onRemove={remove}
        />
      </div>

      <AddRuleBar ruleCap={ruleCap} onAdd={addBlank} />
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}

/**
 * One polite live-region message at a time, cleared after
 * ANNOUNCE_TTL_MS so a stale sentence is not re-read later. The same
 * sentence twice in a row gets a trailing no-break space, so the DOM
 * changes and screen readers announce it again.
 */
function useLiveAnnouncement(): [string, (text: string) => void] {
  const [text, setText] = useState("");
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const timer = timerRef;
    return () => window.clearTimeout(timer.current);
  }, []);
  const announce = useCallback((next: string) => {
    window.clearTimeout(timerRef.current);
    setText((prev) => (prev === next ? `${next}\u00a0` : next));
    timerRef.current = window.setTimeout(() => setText(""), ANNOUNCE_TTL_MS);
  }, []);
  return [text, announce];
}

/** The SPA-event shape addRuleFromEvent takes, for a timeline row. */
function rowEvent(row: SourceTimelineRow) {
  return {
    time: row.t,
    name: row.what,
    is_building: row.isBuilding,
    is_proxy: row.isProxy,
    race: row.race,
    category: row.category,
  };
}

/**
 * What a timeline click does, said back for the live region; null when
 * addRuleFromEvent refuses it (its toast speaks instead). Mirrors the
 * hook: a raise applies unless it inserts at the cap, a duplicate token
 * or the cap refuses a plain add.
 */
function rowAddAnnouncement(
  rules: ReadonlyArray<BuildRule>,
  raise: RepeatRowRaise | null,
  rule: BuildRule | null,
): string | null {
  const atCap = rules.length >= RULES_MAX_PER_BUILD;
  if (raise && !(raise.insert && atCap)) {
    const phrase = describeRule(raise.rule);
    return raise.insert
      ? `Added: ${phrase}.`
      : `Changed rule ${raise.index + 1}: ${phrase}.`;
  }
  if (!rule || atCap) return null;
  if (!raise && rules.some((r) => r.name === rule.name)) return null;
  return `Added: ${describeRule(rule)}.`;
}

/* ------------------------------------------------------------------ */
/* Source timeline (left)                                             */
/* ------------------------------------------------------------------ */

interface SourceTimelinePanelProps {
  rows: BuildEditorRulesProps["sourceRows"];
  rules: ReadonlyArray<BuildRule>;
  countRepeats: boolean;
  ruleCap: boolean;
  onAdd: (row: SourceTimelineRow) => void;
}

function SourceTimelinePanel({
  rows,
  rules,
  countRepeats,
  ruleCap,
  onAdd,
}: SourceTimelinePanelProps) {
  const inUseNames = new Set(rules.map((r) => r.name));
  // Edit mode rebuilds the rows from the saved rules' deadlines.
  const heading = countRepeats
    ? {
        label: "Source replay timeline",
        title: "Times are when each building, unit or upgrade started.",
      }
    : {
        label: "Saved rule times",
        title:
          "Rebuilt from this build's saved rules: each row is a rule's time, not a replay event.",
      };
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-bg-subtle/50">
      <div className="sticky top-0 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-bg-subtle/90 px-3 py-1.5 backdrop-blur">
        <span
          className="text-micro font-semibold uppercase tracking-wider text-text-muted"
          title={heading.title}
        >
          {heading.label} ({rows.length})
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
            {rows.map((r) => (
              <SourceRow
                key={r.key}
                row={r}
                rows={rows}
                rules={rules}
                inRules={inUseNames.has(r.what)}
                countRepeats={countRepeats}
                ruleCap={ruleCap}
                onAdd={onAdd}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface SourceRowProps extends Omit<SourceTimelinePanelProps, "rows"> {
  row: SourceTimelineRow;
  rows: SourceTimelinePanelProps["rows"];
  inRules: boolean;
}

function SourceRow({
  row,
  rows,
  rules,
  inRules,
  countRepeats,
  ruleCap,
  onAdd,
}: SourceRowProps) {
  // A later row of a token already in the rules can raise it to
  // "at least N before then" (the 2nd Stargate asks for 2).
  const raise =
    inRules && countRepeats ? raiseRuleForRepeatRow(rules, rows, row) : null;
  const rowAccent = row.isTech
    ? "bg-accent-cyan/10 border-l-2 border-accent-cyan"
    : "border-l-2 border-transparent opacity-80 hover:opacity-100";
  return (
    <li className={`flex items-center gap-2 px-3 py-1.5 text-caption ${rowAccent}`}>
      <span className="w-10 font-mono tabular-nums text-text-dim">
        {row.timeDisplay}
      </span>
      <span className="flex w-4 items-center justify-center">
        {row.isTech ? (
          <Star
            className="h-3.5 w-3.5 fill-accent-cyan text-accent-cyan drop-shadow-[0_0_4px_rgba(62,192,199,0.55)]"
            aria-label="Tech-defining event"
          />
        ) : null}
      </span>
      <Icon
        name={row.what.replace(/^(Build|Train|Research|Morph)/, "")}
        decorative
        size="sm"
        className="flex-shrink-0"
      />
      <span
        className={`flex-1 truncate ${row.isTech ? "font-semibold text-text" : "text-text"}`}
        title={row.what}
      >
        {row.display}
      </span>
      {row.isProxy ? (
        <span className="rounded border border-warning/50 bg-warning/10 px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wide text-warning">
          Proxy
        </span>
      ) : null}
      <SourceRowAction
        row={row}
        inRules={inRules}
        raise={raise}
        ruleCap={ruleCap}
        onAdd={() => onAdd(row)}
      />
    </li>
  );
}

interface SourceRowActionProps {
  row: SourceTimelineRow;
  inRules: boolean;
  raise: RepeatRowRaise | null;
  ruleCap: boolean;
  onAdd: () => void;
}

/** A row's "+", "At least N" (count this one too) or "In rules" marker. */
function SourceRowAction({
  row,
  inRules,
  raise,
  ruleCap,
  onAdd,
}: SourceRowActionProps) {
  if (raise) {
    return (
      <RepeatChip raise={raise} disabled={raise.insert && ruleCap} onClick={onAdd} />
    );
  }
  if (inRules) {
    return (
      <span
        className="inline-flex items-center gap-1 text-micro font-semibold text-accent-cyan"
        title="Already in your rules"
      >
        <Check className="h-3 w-3" aria-hidden />
        In rules
      </span>
    );
  }
  const rule = ruleFromEvent(rowEvent(row));
  const label = rule ? `Add rule: ${describeRule(rule)}` : "Add as a rule";
  return (
    <button
      type="button"
      onClick={onAdd}
      disabled={ruleCap}
      title={label}
      aria-label={label}
      className="inline-flex h-6 min-w-[44px] items-center justify-center rounded-md bg-accent px-2 text-micro font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Plus className="h-3 w-3" aria-hidden />
    </button>
  );
}

/** "At least N" on a repeated row: inserts a count rule or raises one. */
function RepeatChip({
  raise,
  disabled,
  onClick,
}: {
  raise: RepeatRowRaise;
  disabled: boolean;
  onClick: () => void;
}) {
  const { rule, index, insert } = raise;
  const phrase = describeRule(rule);
  const time = formatTime(rule.time_lt);
  const label = insert
    ? `Add rule: ${phrase}`
    : `Change rule ${index + 1} to ${phrase}`;
  const title = insert
    ? `Count this one too. Adds “At least ${rule.count}” before ${time}; the first ${ruleEntity(rule, 1)} rule stays.`
    : `Count this one too. Changes rule ${index + 1} to “At least ${rule.count}” before ${time}.`;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title}
      className="inline-flex h-6 items-center whitespace-nowrap rounded-md border border-accent-cyan/50 bg-accent-cyan/10 px-2 text-micro font-semibold text-accent-cyan transition-colors hover:bg-accent-cyan/20 disabled:cursor-not-allowed disabled:opacity-50"
    >
      At least {rule.count}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Rules list (right)                                                 */
/* ------------------------------------------------------------------ */

interface RulesListPanelProps {
  panelRef: RefObject<HTMLDivElement | null>;
  rules: ReadonlyArray<BuildRule>;
  focusIndex: number | null;
  onUpdate: BuildEditorRulesProps["updateRule"];
  onQuantity: (idx: number, q: RuleQuantifier, carry: number) => void;
  onCount: BuildEditorRulesProps["setRuleCount"];
  onRemove: (idx: number) => void;
}

function RulesListPanel({
  panelRef,
  rules,
  focusIndex,
  onUpdate,
  onQuantity,
  onCount,
  onRemove,
}: RulesListPanelProps) {
  const contexts = ruleContexts(rules);
  return (
    <div
      ref={panelRef}
      role="region"
      aria-label="Your rules"
      tabIndex={-1}
      className="overflow-hidden rounded-lg border border-border bg-bg-subtle/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <div className="sticky top-0 border-b border-border bg-bg-subtle/90 px-3 py-1.5 text-micro font-semibold uppercase tracking-wider text-text-muted backdrop-blur">
        Your rules ({rules.length})
        <span className="ml-2 font-normal normal-case text-text-dim">
          · start times, not finish times
        </span>
      </div>
      <div className="max-h-[260px] overflow-y-auto sm:max-h-[420px] lg:max-h-[60vh]">
        {rules.length === 0 ? (
          <p className="px-3 py-6 text-caption text-text-dim">
            No rules yet. Click + on a starred event in the timeline: it adds
            “At least 1” of that event, due {AUTO_PICK_TIME_BUFFER_SEC} s after
            the time shown so this game still matches. Raise the number if the
            build needs more, or add a rule below.
          </p>
        ) : (
          <ul role="list">
            {rules.map((rule, idx) => (
              <RuleRow
                key={idx}
                rule={rule}
                index={idx}
                ctx={contexts[idx]}
                autoFocusName={idx === focusIndex}
                onUpdate={(patch) => onUpdate(idx, patch)}
                onQuantity={(q, carry) => onQuantity(idx, q, carry)}
                onCount={(n) => onCount(idx, n)}
                onRemove={() => onRemove(idx)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Add-rule bar                                                       */
/* ------------------------------------------------------------------ */

function AddRuleBar({
  ruleCap,
  onAdd,
}: {
  ruleCap: boolean;
  onAdd: (type: RuleType, announcement: string, proxyOnly?: boolean) => void;
}) {
  const labelId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="flex flex-wrap items-center gap-1.5 text-caption text-text-muted"
    >
      <span id={labelId}>Add a rule:</span>
      {RULE_QUANTIFIERS.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() =>
            onAdd(
              option.addType,
              `Added a blank “${option.label}” rule. Enter a unit, building or upgrade.`,
            )
          }
          disabled={ruleCap}
          title={option.addTitle}
          className={`${ADD_BUTTON_CLASSES} ${TONE_BTN_CLASSES[option.tone]}`}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {option.addLabel}
        </button>
      ))}
      <button
        type="button"
        onClick={() =>
          onAdd(
            "before",
            "Added a blank proxy building rule. Enter a building, like BuildPylon.",
            true,
          )
        }
        disabled={ruleCap}
        title={`Add a building rule that only counts structures placed ${PROXY_RULE_DISTANCE_HINT}.`}
        className={`${ADD_BUTTON_CLASSES} border border-warning/50 bg-warning/15 text-warning hover:bg-warning/25`}
      >
        <MapPin className="h-3.5 w-3.5" aria-hidden />
        Proxy building
      </button>
      {ruleCap ? (
        <span className="text-micro text-text-dim">
          {RULES_MAX_PER_BUILD}-rule limit reached.
        </span>
      ) : null}
    </div>
  );
}
