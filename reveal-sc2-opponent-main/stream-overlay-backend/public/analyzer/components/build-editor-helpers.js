/**
 * Stage 7.5b — Build editor helpers (pure JS, no React).
 *
 * Companion to `build-editor-modal.js`. Exposes:
 *   - SPA event -> server-canonical token mapping (mirrors parseLogLine
 *     in routes/custom_builds_helpers.js).
 *   - Pure-row construction for the modal's source-timeline column.
 *   - Rule constructors + clamps for the v3 rule editor.
 *   - Default-name + slug helpers, debounce, focus-trap, sanitiser.
 *
 * Schema VERSION constant is 3 — matches data/custom_builds.schema.json.
 *
 * UMD-lite wrapper exposes window.BuildEditorHelpers in the browser and
 * module.exports under Node so the helpers are unit-testable.
 *
 * @module build-editor-helpers
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BuildEditorHelpers = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- Constants (mirrored from the server) ----------------------------
  var SCHEMA_VERSION = 3;
  var SIG_TOKEN_REGEX = /^[A-Za-z][A-Za-z0-9]*$/;
  var SIG_VERB_REGEX = /^(Build|Train|Research|Morph)\s+([A-Za-z][A-Za-z0-9]*)$/;
  var SIG_PREFIXED_REGEX = /^(Build|Train|Research|Morph)[A-Z][A-Za-z0-9]*$/;
  var ZERG_UNIT_MORPHS = /^(Baneling|Ravager|Lurker|LurkerMP|BroodLord|Overseer)$/;
  var NOISE_RE = /^(Beacon|Reward|Spray)/;
  var ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;
  var TIME_LT_MIN = 1;
  var TIME_LT_MAX = 1800;
  var COUNT_MIN = 0;
  var COUNT_MAX = 200;
  var DESC_MAX_CHARS = 500;
  var NAME_MIN_CHARS = 3;
  var NAME_MAX_CHARS = 120;
  var STRATEGY_NOTE_MAX_CHARS = 280;
  var STRATEGY_NOTE_MAX_ITEMS = 20;
  var AUTO_PICK_TIME_BUFFER_SEC = 30;
  var RULES_MAX_PER_BUILD = 30;

  var SKILL_LEVELS = [
    { id: 'bronze',      label: 'Bronze' },
    { id: 'silver',      label: 'Silver' },
    { id: 'gold',        label: 'Gold' },
    { id: 'platinum',    label: 'Platinum' },
    { id: 'diamond',     label: 'Diamond' },
    { id: 'master',      label: 'Master' },
    { id: 'grandmaster', label: 'Grandmaster' },
  ];
  var SKILL_LEVEL_IDS = SKILL_LEVELS.map(function (l) { return l.id; });

  var RULE_TYPES = ['before', 'not_before', 'count_max', 'count_min'];
  var RULE_TYPE_ICON = {
    before: '🏛',       // 🏛 (built before)
    not_before: '🚫',   // 🚫 (NOT built before)
    count_max: '🔢',    // 🔢 (count ≤)
    count_min: '📈',    // 📈 (count ≥)
  };
  var RULE_TYPE_LABEL = {
    before: 'built by',
    not_before: 'NOT built by',
    count_max: 'count ≤',
    count_min: 'count ≥',
  };
  var RULE_TYPE_VERB = {
    before: 'before',
    not_before: 'before',
    count_max: 'by',
    count_min: 'by',
  };

  // ---- Event -> signature token mapping --------------------------------
  function spaEventToWhat(ev) {
    if (!ev) return null;
    var raw = String(ev.name == null ? '' : ev.name).trim();
    if (!raw) return null;
    if (NOISE_RE.test(raw)) return null;
    var m = SIG_VERB_REGEX.exec(raw);
    if (m) return m[1] + m[2];
    if (SIG_PREFIXED_REGEX.test(raw)) return raw;
    var noun = raw.replace(/[^A-Za-z0-9]/g, '');
    if (!noun || !/^[A-Za-z]/.test(noun)) return null;
    if (ev.is_building) return 'Build' + noun;
    if (ev.category === 'upgrade') return 'Research' + noun;
    if (ev.race === 'Zerg' && ev.category === 'unit' && ZERG_UNIT_MORPHS.test(noun)) {
      return 'Morph' + noun;
    }
    // Default to 'Build' (matches the server's parseLogLine behavior:
    // bare nouns become Build*).
    return 'Build' + noun;
  }

  function spaEventToRow(ev, idx) {
    var what = spaEventToWhat(ev);
    if (!what || !SIG_TOKEN_REGEX.test(what) || what.length > 80) return null;
    var t = clampRuleTime(Number(ev.time) || 0);
    return {
      key: 't' + t + ':' + what + ':' + idx,
      t: t,
      what: what,
      display: ev.display || ev.name || what,
      time_display: ev.time_display || formatTime(t),
      race: ev.race || 'Neutral',
      category: ev.category || 'unknown',
      is_building: !!ev.is_building,
    };
  }

  function spaEventsToRows(events) {
    var out = [];
    if (!Array.isArray(events)) return out;
    for (var i = 0; i < events.length; i += 1) {
      var row = spaEventToRow(events[i], i);
      if (row) out.push(row);
    }
    return out;
  }

  // ---- Rule constructors + cyclers --------------------------------------
  /**
   * Construct a default rule for a given type, preserving name + time
   * across cycles. Used by the modal's ⚙ type-cycler so changing the
   * type doesn't reset the user's other choices.
   */
  function defaultRuleFor(type, name, time_lt, prevCount) {
    var t = clampRuleTime(time_lt || 1);
    var c = clampCount(prevCount == null ? 1 : prevCount);
    if (type === 'count_max') return { type: 'count_max', name: name, count: c, time_lt: t };
    if (type === 'count_min') return { type: 'count_min', name: name, count: c < 1 ? 1 : c, time_lt: t };
    if (type === 'not_before') return { type: 'not_before', name: name, time_lt: t };
    return { type: 'before', name: name, time_lt: t };
  }

  /**
   * Cycle a rule through the type list (before -> not_before ->
   * count_max -> count_min -> before). Preserves name + time_lt;
   * count carries over for count_* rules.
   */
  function cycleRuleType(rule) {
    var idx = RULE_TYPES.indexOf(rule.type);
    var next = RULE_TYPES[(idx + 1) % RULE_TYPES.length];
    return defaultRuleFor(next, rule.name, rule.time_lt, rule.count);
  }

  /**
   * Construct a 'before' rule from an SPA event. Used by the [+]
   * button next to source-replay rows in the modal.
   */
  function ruleFromEvent(ev) {
    var what = spaEventToWhat(ev);
    if (!what) return null;
    var t = clampRuleTime((Number(ev.time) || 0) + AUTO_PICK_TIME_BUFFER_SEC);
    return { type: 'before', name: what, time_lt: t };
  }

  // ---- Numeric clamps ---------------------------------------------------
  function clampRuleTime(t) {
    var n = Math.round(Number(t) || 0);
    if (n < TIME_LT_MIN) return TIME_LT_MIN;
    if (n > TIME_LT_MAX) return TIME_LT_MAX;
    return n;
  }

  function clampCount(c) {
    var n = Math.round(Number(c) || 0);
    if (n < COUNT_MIN) return COUNT_MIN;
    if (n > COUNT_MAX) return COUNT_MAX;
    return n;
  }

  // ---- Misc helpers -----------------------------------------------------
  function formatTime(t) {
    var sec = Math.max(0, Math.round(Number(t) || 0));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' + s : '' + s);
  }

  /**
   * Smart parse for the inline time field. Accepts:
   *   "3:30" -> 210
   *   "3m30" -> 210
   *   "210"  -> 210
   *   "3"    -> 180  (assume minutes if it's a small int and no separator)
   * Returns null if unparseable.
   */
  function parseTimeInput(input) {
    if (input == null) return null;
    var s = String(input).trim();
    if (!s) return null;
    var m = s.match(/^(\d+)\s*(?:[:m]\s*(\d+))?$/);
    if (!m) return null;
    var a = parseInt(m[1], 10);
    var b = m[2] != null ? parseInt(m[2], 10) : null;
    if (b == null) {
      // Single number: small (1-30) -> minutes; larger -> seconds
      if (a <= 30 && !s.includes(':') && !s.toLowerCase().includes('m')) return a * 60;
      return a;
    }
    return a * 60 + b;
  }

  function deriveDefaultName(data) {
    if (!data || typeof data !== 'object') return 'Custom build';
    var my = String(data.my_race || data.myRace || '').trim();
    var opp = String(data.opp_race || '').trim();
    var strat = String(data.opp_strategy || '').trim();
    if (my && opp) {
      var matchup = my.charAt(0).toUpperCase() + 'v' + opp.charAt(0).toUpperCase();
      if (strat) return matchup + ' — ' + strat;
      return matchup + ' — Custom';
    }
    return strat || 'Custom build';
  }

  function slugify(name) {
    var base = String(name == null ? '' : name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 78);
    if (base.length < 3) base = (base || 'custom') + '-build';
    if (!/^[a-z0-9]/.test(base)) base = 'b-' + base;
    if (!/[a-z0-9]$/.test(base)) base = base + '-x';
    return base.slice(0, 80);
  }

  function debounce(fn, wait) {
    var timer = null;
    function debounced() {
      var args = arguments;
      var ctx = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; fn.apply(ctx, args); }, wait);
    }
    debounced.cancel = function () { if (timer) clearTimeout(timer); timer = null; };
    return debounced;
  }

  var FOCUSABLE_SELECTOR = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function makeFocusTrap(container) {
    return function trap(ev) {
      if (!container || ev.key !== 'Tab') return false;
      var focusables = Array.prototype.slice.call(
        container.querySelectorAll(FOCUSABLE_SELECTOR)
      ).filter(function (el) {
        return el.offsetParent !== null || el === document.activeElement;
      });
      if (!focusables.length) return false;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      var active = document.activeElement;
      if (ev.shiftKey && (active === first || !container.contains(active))) {
        last.focus(); return true;
      }
      if (!ev.shiftKey && (active === last || !container.contains(active))) {
        first.focus(); return true;
      }
      return false;
    };
  }

  /**
   * Validate v3 draft + clamp values. Returns {ok, errors, payload}.
   */
  function sanitiseDraft(draft) {
    var errors = {};
    var d = draft || {};
    var name = String(d.name || '').trim();
    if (name.length < NAME_MIN_CHARS) errors.name = 'Need at least ' + NAME_MIN_CHARS + ' chars.';
    if (name.length > NAME_MAX_CHARS) errors.name = 'Max ' + NAME_MAX_CHARS + ' chars.';
    var description = String(d.description || '').slice(0, DESC_MAX_CHARS);
    var rules = Array.isArray(d.rules) ? d.rules.map(sanitiseRule).filter(Boolean) : [];
    if (rules.length === 0) errors.rules = 'Need at least one rule.';
    if (rules.length > RULES_MAX_PER_BUILD) errors.rules = 'At most ' + RULES_MAX_PER_BUILD + ' rules.';
    var skillLevel = SKILL_LEVEL_IDS.indexOf(d.skill_level) >= 0 ? d.skill_level : null;
    var payload = {
      name: name,
      description: description,
      race: d.race || 'Protoss',
      vs_race: d.vs_race || 'Random',
      skill_level: skillLevel,
      win_conditions: clipStrings(d.win_conditions),
      loses_to: clipStrings(d.loses_to),
      transitions_into: clipStrings(d.transitions_into),
      rules: rules,
      source_replay_id: d.source_replay_id || null,
    };
    if (d.id) payload.id = d.id;
    return { ok: Object.keys(errors).length === 0, errors: errors, payload: payload };
  }

  function sanitiseRule(r) {
    if (!r || typeof r !== 'object') return null;
    if (RULE_TYPES.indexOf(r.type) < 0) return null;
    if (typeof r.name !== 'string' || !SIG_TOKEN_REGEX.test(r.name)) return null;
    var time_lt = clampRuleTime(r.time_lt);
    if (r.type === 'count_max') return { type: 'count_max', name: r.name, count: clampCount(r.count), time_lt: time_lt };
    if (r.type === 'count_min') return { type: 'count_min', name: r.name, count: Math.max(1, clampCount(r.count || 1)), time_lt: time_lt };
    if (r.type === 'not_before') return { type: 'not_before', name: r.name, time_lt: time_lt };
    return { type: 'before', name: r.name, time_lt: time_lt };
  }

  function clipStrings(arr) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length && out.length < STRATEGY_NOTE_MAX_ITEMS; i += 1) {
      var s = String(arr[i] == null ? '' : arr[i]).trim();
      if (!s) continue;
      out.push(s.slice(0, STRATEGY_NOTE_MAX_CHARS));
    }
    return out;
  }

  // ---- Public API -------------------------------------------------------
  return {
    // event mapping
    spaEventToWhat: spaEventToWhat,
    spaEventToRow: spaEventToRow,
    spaEventsToRows: spaEventsToRows,
    // rule construction
    defaultRuleFor: defaultRuleFor,
    cycleRuleType: cycleRuleType,
    ruleFromEvent: ruleFromEvent,
    sanitiseRule: sanitiseRule,
    // clamps + parsers
    clampRuleTime: clampRuleTime,
    clampCount: clampCount,
    parseTimeInput: parseTimeInput,
    // misc
    formatTime: formatTime,
    deriveDefaultName: deriveDefaultName,
    slugify: slugify,
    debounce: debounce,
    makeFocusTrap: makeFocusTrap,
    sanitiseDraft: sanitiseDraft,
    // constants
    SCHEMA_VERSION: SCHEMA_VERSION,
    SKILL_LEVELS: SKILL_LEVELS,
    SKILL_LEVEL_IDS: SKILL_LEVEL_IDS,
    RULE_TYPES: RULE_TYPES,
    RULE_TYPE_ICON: RULE_TYPE_ICON,
    RULE_TYPE_LABEL: RULE_TYPE_LABEL,
    RULE_TYPE_VERB: RULE_TYPE_VERB,
    DESC_MAX_CHARS: DESC_MAX_CHARS,
    NAME_MIN_CHARS: NAME_MIN_CHARS,
    NAME_MAX_CHARS: NAME_MAX_CHARS,
    STRATEGY_NOTE_MAX_CHARS: STRATEGY_NOTE_MAX_CHARS,
    STRATEGY_NOTE_MAX_ITEMS: STRATEGY_NOTE_MAX_ITEMS,
    RULES_MAX_PER_BUILD: RULES_MAX_PER_BUILD,
    AUTO_PICK_TIME_BUFFER_SEC: AUTO_PICK_TIME_BUFFER_SEC,
    TIME_LT_MIN: TIME_LT_MIN,
    TIME_LT_MAX: TIME_LT_MAX,
    COUNT_MIN: COUNT_MIN,
    COUNT_MAX: COUNT_MAX,
    ID_PATTERN: ID_PATTERN,
  };
});
