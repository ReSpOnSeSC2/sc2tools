/**
 * Stage 7.5b — Build editor modal (rule-based, JSX via React.createElement).
 *
 * Loaded by index.html via <script src="..."> (no babel compile needed).
 * Reads helpers from window.BuildEditorHelpers. Attaches itself to
 * window.BuildEditorModal so the inline JSX in BuildOrderTimeline can
 * mount it as React.createElement(window.BuildEditorModal, {...}).
 *
 * Four sections (matching the user-approved design):
 *   1. Basics — name, race, vs, skill_level w/ league icons, share toggle, strategy notes
 *   2. Match rules — left = source-replay events with [+] click-to-add;
 *                   right = current rules list with ⚙ type cycle, inline
 *                   time edit, count edit, × remove. + custom rule picker.
 *   3. Match preview — ✓N/M boolean preview + almost-matches band with
 *                     failure reason inline. Paginated 5/page.
 *   4. Sticky save bar — Cancel / Save build / Save & Reclassify.
 *
 * Posts to /api/custom-builds/* (absolute paths — the SPA's API const
 * is "/api/analyzer" which would corrupt the URL).
 *
 * @module build-editor-modal
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.React) return;
  var React = window.React;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useRef = React.useRef;
  var useMemo = React.useMemo;
  var H = window.BuildEditorHelpers;
  if (!H) { console.error('[build-editor-modal] BuildEditorHelpers missing'); return; }
  var c = React.createElement;

  var PREVIEW_DEBOUNCE_MS = 300;
  var PREVIEW_PAGE_SIZE = 5;
  var TOAST_TTL_MS = 6000;
  var LEAGUE_ICON_BASE = '/static/icons/leagues/';
  var RACE_OPTIONS = ['Protoss', 'Terran', 'Zerg'];
  var VS_RACE_OPTIONS = ['Protoss', 'Terran', 'Zerg', 'Random', 'Any'];

  // =====================================================================
  // Top-level component
  // =====================================================================
  function BuildEditorModal(props) {
    var open = !!props.open;
    var game = props.game || {};
    var gameId = props.gameId || game.game_id || '';
    var initialDraft = props.draft || null;
    var profileReady = props.profileReady !== false;
    var onClose = props.onClose || function () {};
    var onSaved = props.onSaved || function () {};
    var socket = props.socket || (typeof window !== 'undefined' ? window.__sc2_socket : null);
    // settings-pr1h: when editId is set, the modal opens in EDIT mode
    // for an existing custom build. Save sends PUT /api/custom-builds/:id
    // and the header reflects 'Edit custom build' instead of 'Save as new'.
    var editId = props.editId || (initialDraft && initialDraft.id) || '';
    var isEditMode = !!editId;

    var sourceRows = useMemo(function () {
      return H.spaEventsToRows(game.events || []);
    }, [game]);

    var defaultName = useMemo(function () {
      if (initialDraft && initialDraft.name) return initialDraft.name;
      return H.deriveDefaultName(game);
    }, [game, initialDraft]);

    // ---- Editable state ----------------------------------------------
    var [name, setName] = useState(defaultName);
    var [description, setDescription] = useState((initialDraft && initialDraft.description) || '');
    var [race, setRace] = useState((initialDraft && initialDraft.race) || game.my_race || 'Protoss');
    var [vsRace, setVsRace] = useState((initialDraft && initialDraft.vs_race) || game.opp_race || 'Random');
    var [skillLevel, setSkillLevel] = useState((initialDraft && initialDraft.skill_level) || null);
    var [skillOpen, setSkillOpen] = useState(false);
    var [winConditions, setWinConditions] = useState((initialDraft && initialDraft.win_conditions) || []);
    var [losesTo, setLosesTo] = useState((initialDraft && initialDraft.loses_to) || []);
    var [transitionsInto, setTransitionsInto] = useState((initialDraft && initialDraft.transitions_into) || []);
    var [shareWithCommunity, setShareWithCommunity] = useState(true);
    var [showStrategyNotes, setShowStrategyNotes] = useState(false);
    var [rules, setRules] = useState((initialDraft && Array.isArray(initialDraft.rules)) ? initialDraft.rules : []);
    var [editingTimeIdx, setEditingTimeIdx] = useState(-1);
    var [editingCountIdx, setEditingCountIdx] = useState(-1);
    var [previewResult, setPreviewResult] = useState(null);
    var [previewLoading, setPreviewLoading] = useState(false);
    var [previewError, setPreviewError] = useState(null);
    var [previewPage, setPreviewPage] = useState(0);
    var [almostPage, setAlmostPage] = useState(0);
    // Stage 7.5b: inspect (expand) + hide (X) per match row.
    var [expandedMatch, setExpandedMatch] = useState(null);  // game_id of currently-expanded row
    var [hiddenMatches, setHiddenMatches] = useState(function () { return new Set(); });
    var [inspectCache, setInspectCache] = useState({});       // game_id -> events[]
    var [inspectLoading, setInspectLoading] = useState({});   // game_id -> bool
    var [saving, setSaving] = useState(false);
    var [saveError, setSaveError] = useState(null);
    var [errors, setErrors] = useState({});
    var [reclassifyProgress, setReclassifyProgress] = useState(null);
    var [toasts, setToasts] = useState([]);
    var [confirmingClose, setConfirmingClose] = useState(false);

    var containerRef = useRef(null);
    var previousActiveRef = useRef(null);
    var pristineRef = useRef(null);

    // Pristine snapshot for unsaved-change detection
    useEffect(function () {
      if (!open) return;
      pristineRef.current = JSON.stringify({
        name: defaultName, description: (initialDraft && initialDraft.description) || '',
        race: race, vsRace: vsRace, skillLevel: skillLevel,
        rules: rules, winConditions: winConditions,
        losesTo: losesTo, transitionsInto: transitionsInto,
      });
    }, [open]);

    // Body scroll lock + focus capture/restore
    useEffect(function () {
      if (!open) return undefined;
      previousActiveRef.current = document.activeElement;
      var prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      var t = setTimeout(function () {
        var first = containerRef.current && containerRef.current.querySelector('input, select, textarea, button');
        if (first && first.focus) first.focus();
      }, 30);
      return function () {
        document.body.style.overflow = prevOverflow;
        clearTimeout(t);
        var prev = previousActiveRef.current;
        if (prev && prev.focus) prev.focus();
      };
    }, [open]);

    // Esc + Tab key handler
    var trap = useMemo(function () { return H.makeFocusTrap(containerRef.current); }, [containerRef.current]);
    useEffect(function () {
      if (!open) return undefined;
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.stopPropagation(); attemptClose(); }
        else if (ev.key === 'Tab') { if (trap(ev)) ev.preventDefault(); }
      }
      window.addEventListener('keydown', onKey, true);
      return function () { window.removeEventListener('keydown', onKey, true); };
    }, [open, trap, name, rules]);

    // Debounced preview
    useEffect(function () {
      if (!open) return undefined;
      if (rules.length === 0) {
        setPreviewResult({ matches: [], almost_matches: [], scanned_games: 0, truncated: false });
        return undefined;
      }
      setPreviewError(null);
      var fn = H.debounce(function () {
        setPreviewLoading(true);
        fetch('/api/custom-builds/preview-matches', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rules: rules, race: race, vs_race: vsRace }),
        }).then(function (r) { return r.ok ? r.json() : r.json().then(function (j) { return Promise.reject(j); }); })
        .then(function (j) { setPreviewResult(j); setPreviewLoading(false); })
        .catch(function (e) { setPreviewError((e && e.error) || 'preview failed'); setPreviewLoading(false); });
      }, PREVIEW_DEBOUNCE_MS);
      fn();
      return function () { if (fn.cancel) fn.cancel(); };
    }, [open, rules, race, vsRace]);

    // Reset pagination when preview changes
    useEffect(function () { setPreviewPage(0); setAlmostPage(0); }, [previewResult]);

    // Socket.io reclassify_progress
    useEffect(function () {
      if (!open || !socket || typeof socket.on !== 'function') return undefined;
      function onProgress(payload) { setReclassifyProgress(payload || null); }
      socket.on('reclassify_progress', onProgress);
      return function () { socket.off && socket.off('reclassify_progress', onProgress); };
    }, [open, socket]);

    // Close + reset skill dropdown if outside click
    useEffect(function () {
      if (!skillOpen) return undefined;
      function onDocClick(ev) {
        var t = ev.target;
        var node = containerRef.current && containerRef.current.querySelector('[data-skill-dropdown]');
        if (node && !node.contains(t)) setSkillOpen(false);
      }
      window.addEventListener('click', onDocClick, true);
      return function () { window.removeEventListener('click', onDocClick, true); };
    }, [skillOpen]);

    // ---- Helpers -----------------------------------------------------
    function pushToast(kind, text, action) {
      var id = Date.now() + Math.random();
      setToasts(function (xs) { return xs.concat([{ id: id, kind: kind, text: text, action: action }]); });
      setTimeout(function () { setToasts(function (xs) { return xs.filter(function (t) { return t.id !== id; }); }); }, TOAST_TTL_MS);
    }

    function isDirty() {
      var current = JSON.stringify({
        name: name, description: description, race: race, vsRace: vsRace, skillLevel: skillLevel,
        rules: rules, winConditions: winConditions, losesTo: losesTo, transitionsInto: transitionsInto,
      });
      return current !== pristineRef.current;
    }

    function attemptClose() {
      if (!isDirty() || confirmingClose) { setConfirmingClose(false); onClose(); return; }
      setConfirmingClose(true);
      pushToast('warn', 'Unsaved changes — press Esc again or click X to discard.');
    }

    function addRuleFromEvent(ev) {
      var newRule = H.ruleFromEvent(ev);
      if (!newRule) return;
      // Don't add if a rule with this name already exists
      var dup = rules.some(function (r) { return r.name === newRule.name; });
      if (dup) { pushToast('warn', newRule.name + ' is already in your rules.'); return; }
      if (rules.length >= H.RULES_MAX_PER_BUILD) {
        pushToast('warn', 'Rule cap reached (' + H.RULES_MAX_PER_BUILD + ').');
        return;
      }
      setRules(rules.concat([newRule]));
    }

    function addCustomRule(type) {
      if (rules.length >= H.RULES_MAX_PER_BUILD) {
        pushToast('warn', 'Rule cap reached (' + H.RULES_MAX_PER_BUILD + ').');
        return;
      }
      var blank = H.defaultRuleFor(type, 'Build', 60, 1);
      blank.name = '';
      setRules(rules.concat([blank]));
    }

    function updateRule(idx, patch) {
      setRules(rules.map(function (r, i) { return i === idx ? Object.assign({}, r, patch) : r; }));
    }

    function cycleRule(idx) {
      setRules(rules.map(function (r, i) { return i === idx ? H.cycleRuleType(r) : r; }));
    }

    function removeRule(idx) {
      setRules(rules.filter(function (_, i) { return i !== idx; }));
    }

    function commitTimeEdit(idx, raw) {
      var parsed = H.parseTimeInput(raw);
      if (parsed != null) updateRule(idx, { time_lt: H.clampRuleTime(parsed) });
      setEditingTimeIdx(-1);
    }

    function commitCountEdit(idx, raw) {
      var n = parseInt(raw, 10);
      if (!isNaN(n)) {
        var lo = rules[idx].type === 'count_min' ? 1 : 0;
        updateRule(idx, { count: Math.max(lo, H.clampCount(n)) });
      }
      setEditingCountIdx(-1);
    }

    function toggleInspect(gameId) {
      if (!gameId) return;
      if (expandedMatch === gameId) { setExpandedMatch(null); return; }
      setExpandedMatch(gameId);
      if (inspectCache[gameId] || inspectLoading[gameId]) return;
      setInspectLoading(function (p) { var n = Object.assign({}, p); n[gameId] = true; return n; });
      fetch('/api/analyzer/games/' + encodeURIComponent(gameId) + '/build-order')
        .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
        .then(function (j) {
          setInspectCache(function (p) { var n = Object.assign({}, p); n[gameId] = j.events || []; return n; });
        })
        .catch(function () { /* ignore */ })
        .finally(function () {
          setInspectLoading(function (p) { var n = Object.assign({}, p); delete n[gameId]; return n; });
        });
    }

    function hideMatch(gameId) {
      if (!gameId) return;
      setHiddenMatches(function (prev) { var n = new Set(prev); n.add(gameId); return n; });
      if (expandedMatch === gameId) setExpandedMatch(null);
    }

    function unhideAll() { setHiddenMatches(new Set()); }

    function buildPayload() {
      return H.sanitiseDraft({
        name: name, description: description, race: race, vs_race: vsRace,
        skill_level: skillLevel,
        win_conditions: winConditions, loses_to: losesTo, transitions_into: transitionsInto,
        rules: rules, source_replay_id: gameId || null,
      });
    }

    function postSave(thenReclassify) {
      var sanitised = buildPayload();
      if (!sanitised.ok) {
        setErrors(sanitised.errors);
        pushToast('error', 'Fix the highlighted fields before saving.');
        return;
      }
      setErrors({}); setSaving(true); setSaveError(null);
      var url = isEditMode
        ? ('/api/custom-builds/' + encodeURIComponent(editId))
        : '/api/custom-builds/';
      var method = isEditMode ? 'PUT' : 'POST';
      fetch(url, {
        method: method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sanitised.payload),
      }).then(function (r) { return r.ok ? r.json() : r.json().then(function (j) { return Promise.reject(j); }); })
      .then(function (saved) {
        setSaving(false);
        pristineRef.current = JSON.stringify(stateForPristine());
        pushToast('success', (isEditMode ? 'Updated “' : 'Saved “') + saved.name + '”.', { label: 'View build', href: '/builds/' + saved.id });
        if (shareWithCommunity) {
          fetch('/api/custom-builds/sync', { method: 'POST' })
            .then(function () { pushToast('success', 'Shared with community.'); })
            .catch(function () { /* periodic syncer will retry */ });
        }
        onSaved(saved);
        if (thenReclassify) doReclassify();
        else onClose();
      }).catch(function (e) {
        setSaving(false);
        var detail = (e && e.error) || 'save failed';
        setSaveError(detail); pushToast('error', 'Save failed: ' + detail);
      });
    }

    function stateForPristine() {
      return {
        name: name, description: description, race: race, vsRace: vsRace, skillLevel: skillLevel,
        rules: rules, winConditions: winConditions, losesTo: losesTo, transitionsInto: transitionsInto,
      };
    }

    function doReclassify() {
      setReclassifyProgress({ processed: 0, total: 0, changed: 0 });
      fetch('/api/custom-builds/reclassify', { method: 'POST' })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (j) { return Promise.reject(j); }); })
        .then(function (summary) {
          setReclassifyProgress(null);
          pushToast('success', 'Reclassified ' + (summary.scanned || 0) + ' games (' + (summary.changed || 0) + ' moved).');
          // Force the analyzer's server-side cache to reload from disk
          // so the next /api/analyzer/games call returns the freshly
          // re-bucketed games. The watcher's 4s polling interval
          // otherwise leaves dbCache.meta stale, which means the
          // 'My Build' column on the games table keeps showing the
          // old (or blank) build name. Then dispatch a window event
          // so the App component bumps dbRev and every dbRev-keyed
          // view refetches immediately.
          fetch('/api/analyzer/reload', { method: 'POST' })
            .catch(function () { /* best-effort */ })
            .then(function () {
              try {
                window.dispatchEvent(new CustomEvent('sc2:analyzer-db-changed'));
              } catch (_) { /* best-effort */ }
              onClose();
            });
        }).catch(function (e) {
          setReclassifyProgress(null);
          pushToast('error', 'Reclassify failed: ' + ((e && e.error) || 'unknown'));
        });
    }

    if (!open) return null;

    var rulesByName = useMemo(function () {
      var m = {};
      rules.forEach(function (r) { m[r.name] = true; });
      return m;
    }, [rules]);

    return c('div', {
      className: 'fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4',
      role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Save as new build',
      onClick: function (ev) { if (ev.target === ev.currentTarget) attemptClose(); },
    },
      c('div', {
        ref: containerRef,
        className: 'w-full max-w-5xl max-h-[92vh] flex flex-col bg-base-900 ring-soft rounded-lg border border-base-700 shadow-xl',
      },
        renderHeader(name, attemptClose, !profileReady, isEditMode),
        c('div', { className: 'flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-6' },
          renderSection1Basics({
            name: name, setName: setName, description: description, setDescription: setDescription,
            race: race, setRace: setRace, vsRace: vsRace, setVsRace: setVsRace,
            skillLevel: skillLevel, setSkillLevel: setSkillLevel,
            skillOpen: skillOpen, setSkillOpen: setSkillOpen,
            shareWithCommunity: shareWithCommunity, setShareWithCommunity: setShareWithCommunity,
            showStrategyNotes: showStrategyNotes, setShowStrategyNotes: setShowStrategyNotes,
            winConditions: winConditions, setWinConditions: setWinConditions,
            losesTo: losesTo, setLosesTo: setLosesTo,
            transitionsInto: transitionsInto, setTransitionsInto: setTransitionsInto,
            errors: errors,
          }),
          renderSection2Rules({
            sourceRows: sourceRows, rulesByName: rulesByName, addRuleFromEvent: addRuleFromEvent,
            rules: rules, updateRule: updateRule, cycleRule: cycleRule, removeRule: removeRule,
            editingTimeIdx: editingTimeIdx, setEditingTimeIdx: setEditingTimeIdx,
            commitTimeEdit: commitTimeEdit,
            editingCountIdx: editingCountIdx, setEditingCountIdx: setEditingCountIdx,
            commitCountEdit: commitCountEdit,
            addCustomRule: addCustomRule, errors: errors,
          }),
          (window.BuildEditorMatchList && window.BuildEditorMatchList.render({
            previewResult: previewResult, previewLoading: previewLoading, previewError: previewError,
            previewPage: previewPage, setPreviewPage: setPreviewPage,
            almostPage: almostPage, setAlmostPage: setAlmostPage,
            rules: rules,
            expandedMatch: expandedMatch, toggleInspect: toggleInspect,
            hiddenMatches: hiddenMatches, hideMatch: hideMatch, unhideAll: unhideAll,
            inspectCache: inspectCache, inspectLoading: inspectLoading,
          }))
        ),
        renderSaveBar({
          attemptClose: attemptClose, postSave: postSave, saving: saving,
          previewLoading: previewLoading, saveError: saveError, rules: rules,
          reclassifyProgress: reclassifyProgress,
        }),
        renderToasts(toasts)
      )
    );
  }

  // =====================================================================
  // Section renderers
  // =====================================================================
  function renderHeader(name, onCloseClick, showProfileWarn, isEditMode) {
    return c('div', { className: 'flex items-center gap-3 px-5 py-3 border-b border-base-700' },
      c('span', { className: 'text-[11px] uppercase tracking-wider text-neutral-500' },
        isEditMode ? 'Edit custom build' : 'Save as new build'),
      c('span', { className: 'text-sm text-neutral-200 truncate' }, name || 'Untitled'),
      showProfileWarn ? c('span', {
        className: 'text-[10px] text-amber-400 ml-2',
        title: 'Set up your profile in /settings to attribute community uploads.',
      }, 'profile.json missing') : null,
      c('button', {
        className: 'ml-auto text-neutral-400 hover:text-neutral-100',
        'aria-label': 'Close', onClick: onCloseClick,
      }, '✕')
    );
  }

  function renderSection1Basics(s) {
    var input = 'w-full bg-base-800 border border-base-700 rounded px-2 py-1 text-sm text-neutral-100 focus:outline-none focus:ring-1 focus:ring-accent-500';
    return c('section', { 'aria-label': 'Basics' },
      c('h3', { className: 'text-xs uppercase text-neutral-500 mb-2' }, '1 · Basics'),
      c('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-3' },
        renderField('Name', s.errors.name,
          c('input', {
            className: input, type: 'text', value: s.name, maxLength: H.NAME_MAX_CHARS,
            'aria-required': 'true',
            onChange: function (e) { s.setName(e.target.value); },
          })),
        renderField('Recommended for', null, renderSkillPicker(s)),
        renderField('Race', null,
          c('select', { className: input, value: s.race, onChange: function (e) { s.setRace(e.target.value); } },
            RACE_OPTIONS.map(function (r) { return c('option', { key: r, value: r }, r); }))),
        renderField('Vs race', null,
          c('select', { className: input, value: s.vsRace, onChange: function (e) { s.setVsRace(e.target.value); } },
            VS_RACE_OPTIONS.map(function (r) { return c('option', { key: r, value: r }, r); })))
      ),
      c('div', { className: 'mt-3' },
        renderField('Description (' + (s.description.length) + '/' + H.DESC_MAX_CHARS + ')', null,
          c('textarea', {
            className: input + ' h-20 resize-none', maxLength: H.DESC_MAX_CHARS,
            value: s.description, onChange: function (e) { s.setDescription(e.target.value); },
          }))),
      c('label', { className: 'flex items-start gap-2 mt-3 cursor-pointer' },
        c('input', {
          type: 'checkbox', className: 'mt-1', checked: s.shareWithCommunity,
          onChange: function (e) { s.setShareWithCommunity(e.target.checked); },
        }),
        c('span', { className: 'text-sm text-neutral-300' },
          c('span', null, 'Share with community'),
          c('span', { className: 'block text-[10px] text-neutral-500' },
            'Visible to all players. ',
            c('a', { href: '/settings#privacy', className: 'underline hover:text-neutral-300' }, 'Privacy details')))),
      c('div', { className: 'mt-3' },
        c('button', {
          type: 'button', className: 'text-xs text-neutral-400 hover:text-neutral-200',
          'aria-expanded': s.showStrategyNotes,
          onClick: function () { s.setShowStrategyNotes(!s.showStrategyNotes); },
        }, (s.showStrategyNotes ? '▾' : '▸') + ' Strategy notes (optional)'),
        s.showStrategyNotes ? c('div', { className: 'mt-2 grid grid-cols-1 md:grid-cols-3 gap-3' },
          renderChipsField('Win conditions', s.winConditions, s.setWinConditions),
          renderChipsField('Loses to', s.losesTo, s.setLosesTo),
          renderChipsField('Transitions into', s.transitionsInto, s.setTransitionsInto)
        ) : null)
    );
  }

  function renderSkillPicker(s) {
    var btn = 'w-full bg-base-800 border border-base-700 rounded px-2 py-1 text-sm text-neutral-100 flex items-center gap-2 hover:bg-base-700';
    var current = H.SKILL_LEVELS.find(function (l) { return l.id === s.skillLevel; });
    return c('div', { 'data-skill-dropdown': true, className: 'relative' },
      c('button', {
        type: 'button', className: btn,
        'aria-haspopup': 'listbox', 'aria-expanded': s.skillOpen,
        onClick: function (ev) { ev.stopPropagation(); s.setSkillOpen(!s.skillOpen); },
      },
        current ? c('img', { src: LEAGUE_ICON_BASE + current.id + '.svg', className: 'w-5 h-5', alt: '' }) : null,
        c('span', { className: 'flex-1 text-left' }, current ? current.label : '— none —'),
        c('span', { className: 'text-neutral-500' }, '▾')
      ),
      s.skillOpen ? c('ul', {
        role: 'listbox',
        className: 'absolute z-10 mt-1 w-full bg-base-800 border border-base-700 rounded shadow-lg max-h-72 overflow-y-auto',
      },
        c('li', null,
          c('button', {
            type: 'button',
            className: 'w-full text-left px-2 py-1.5 text-sm text-neutral-400 hover:bg-base-700',
            onClick: function () { s.setSkillLevel(null); s.setSkillOpen(false); },
          }, '— none —')),
        H.SKILL_LEVELS.map(function (l) {
          return c('li', { key: l.id },
            c('button', {
              type: 'button',
              className: 'w-full text-left px-2 py-1.5 text-sm text-neutral-200 hover:bg-base-700 flex items-center gap-2',
              onClick: function () { s.setSkillLevel(l.id); s.setSkillOpen(false); },
            },
              c('img', { src: LEAGUE_ICON_BASE + l.id + '.svg', className: 'w-5 h-5', alt: '' }),
              c('span', null, l.label)
            ));
        })
      ) : null
    );
  }

  function renderChipsField(label, list, setList) {
    return c('div', null,
      c('label', { className: 'text-[10px] uppercase tracking-wider text-neutral-500' }, label),
      c('div', { className: 'flex flex-wrap gap-1 mt-1' },
        list.map(function (item, i) {
          return c('span', { key: i,
            className: 'text-[11px] bg-base-800 rounded px-1.5 py-0.5 text-neutral-200 border border-base-700' },
            item,
            c('button', {
              className: 'ml-1 text-neutral-500 hover:text-neutral-200',
              'aria-label': 'Remove ' + item,
              onClick: function () { setList(list.filter(function (_, j) { return j !== i; })); },
            }, '×'));
        }),
        list.length < H.STRATEGY_NOTE_MAX_ITEMS ? c('input', {
          className: 'flex-1 min-w-[80px] bg-base-800 border border-base-700 rounded px-1 py-0.5 text-[11px]',
          placeholder: '+ add', maxLength: H.STRATEGY_NOTE_MAX_CHARS,
          onKeyDown: function (e) {
            if (e.key === 'Enter' && e.target.value.trim()) {
              e.preventDefault(); setList(list.concat([e.target.value.trim()])); e.target.value = '';
            }
          },
        }) : null)
    );
  }

  function renderField(label, error, control) {
    return c('div', null,
      c('label', { className: 'text-[10px] uppercase tracking-wider text-neutral-500' }, label),
      control,
      error ? c('div', { className: 'text-[11px] text-loss-500 mt-0.5', 'aria-live': 'polite' }, error) : null
    );
  }

  // =====================================================================
  // Section 2 — Rules editor
  // =====================================================================
  function renderSection2Rules(s) {
    return c('section', { 'aria-label': 'Match rules' },
      c('h3', { className: 'text-xs uppercase text-neutral-500 mb-2' },
        '2 · Match rules ',
        c('span', { className: 'normal-case text-neutral-600' },
          '(' + s.rules.length + '/' + H.RULES_MAX_PER_BUILD + ' · ALL must pass)')),
      s.errors.rules ? c('div', { className: 'text-[11px] text-loss-500 mb-2', 'aria-live': 'polite' }, s.errors.rules) : null,
      c('div', { className: 'grid grid-cols-1 lg:grid-cols-2 gap-3' },
        renderSourceTimeline(s),
        renderRulesList(s)
      ),
      c('div', { className: 'mt-2 flex items-center gap-2 text-xs text-neutral-500 flex-wrap' },
        c('span', null, 'Add custom rule:'),
        renderAddCustomBtn('✓ built by',  'before',     s.addCustomRule, 'win'),
        renderAddCustomBtn('✗ NOT by',    'not_before', s.addCustomRule, 'loss'),
        renderAddCustomBtn('≤ count',      'count_max',   s.addCustomRule, 'neutral'),
        renderAddCustomBtn('= count',      'count_exact', s.addCustomRule, 'neutral'),
        renderAddCustomBtn('≥ count',      'count_min',   s.addCustomRule, 'neutral')
      )
    );
  }

  function renderAddCustomBtn(label, type, addCustomRule, tone) {
    var cls = tone === 'win' ? 'bg-win-500/20 text-win-500 hover:bg-win-500/30 border border-win-500/40'
            : tone === 'loss' ? 'bg-loss-500/20 text-loss-500 hover:bg-loss-500/30 border border-loss-500/40'
            : 'bg-base-700 text-neutral-300 hover:bg-base-600 border border-base-600';
    return c('button', {
      key: type, type: 'button',
      className: 'px-2 py-0.5 rounded text-xs font-medium ' + cls,
      onClick: function () { addCustomRule(type); },
    }, label);
  }

  function renderSourceTimeline(s) {
    return c('div', { className: 'bg-base-800/40 rounded border border-base-700 max-h-[360px] overflow-y-auto' },
      c('div', { className: 'sticky top-0 bg-base-800/90 px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-500 border-b border-base-700 flex items-center gap-2' },
        c('span', null, 'Source replay timeline (' + s.sourceRows.length + ')'),
        c('span', { className: 'normal-case text-[9px] text-neutral-600' },
          '· ★ = tech-defining (good to add)')),
      s.sourceRows.length === 0 ? c('div', { className: 'p-3 text-xs text-neutral-500' }, 'No mappable events on this game.')
      : c('ul', { className: 'divide-y divide-base-700' },
          s.sourceRows.map(function (r) {
            var inRules = !!s.rulesByName[r.what];
            // Stage 7.5b: tech-worthy events (tech buildings, key units,
            // upgrades) get a subtle accent background so users know which
            // rows are worth promoting to a rule. Cosmetic / common events
            // (Pylon, Gateway, Probe) render in muted color.
            var tech = H.isTechToken && H.isTechToken(r.what);
            var rowClass = 'flex items-center gap-2 px-3 py-1.5 text-xs ' +
              (tech ? 'bg-accent-500/5 hover:bg-accent-500/10' : 'opacity-70 hover:opacity-100');
            return c('li', { key: r.key, className: rowClass },
              c('span', { className: 'font-mono text-[11px] text-neutral-400 w-10 tabular-nums' }, r.time_display),
              tech ? c('span', { className: 'text-[10px] text-accent-500', title: 'Tech-defining event' }, '★') : c('span', { className: 'w-3' }),
              c('span', { className: 'flex-1 truncate ' + (tech ? 'text-neutral-100 font-medium' : 'text-neutral-300') }, r.display),
              c('span', { className: 'text-[10px] text-neutral-500 tabular-nums' }, r.what),
              inRules
                ? c('span', { className: 'text-[10px] text-accent-500 ml-1' }, '✓ in rules')
                : c('button', {
                    className: 'px-2 py-0.5 rounded bg-accent-500 text-white text-[10px] hover:opacity-90',
                    title: 'Add as a rule', 'aria-label': 'Add ' + r.what + ' as a rule',
                    onClick: function () { s.addRuleFromEvent({ time: r.t, name: r.what, is_building: r.is_building, race: r.race, category: r.category }); },
                  }, '+'));
          }))
    );
  }

  function renderRulesList(s) {
    return c('div', { className: 'bg-base-800/40 rounded border border-base-700 max-h-[360px] overflow-y-auto' },
      c('div', { className: 'sticky top-0 bg-base-800/90 px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-500 border-b border-base-700' },
        'Your rules (' + s.rules.length + ') · click ⚙ to cycle type · click time to edit'),
      s.rules.length === 0 ? c('div', { className: 'p-3 text-xs text-neutral-500' },
        'No rules yet. Click + on a ★ tech-defining event in the left column, or use the ✓ / ✗ / ≤ / ≥ buttons below to add a custom rule.')
      : c('ul', { className: 'divide-y divide-base-700' },
          s.rules.map(function (rule, i) { return renderRuleChip(rule, i, s); }))
    );
  }

  function renderRuleChip(rule, idx, s) {
    var isCount = rule.type === 'count_max' || rule.type === 'count_exact' || rule.type === 'count_min';
    return c('li', { key: idx, className: 'flex items-center gap-2 px-3 py-1.5 text-xs' },
      // Cycle badge — shows icon + label/count, color-coded by type.
      // Click to rotate type. Tooltip explains the cycle.
      renderCycleBadge(rule, idx, s, isCount),
      // Event-name input (the token like BuildStargate)
      c('input', {
        className: 'flex-1 min-w-0 bg-transparent border border-transparent focus:border-base-600 rounded px-1 text-neutral-100 text-[11px]',
        type: 'text', value: rule.name, placeholder: 'BuildStargate',
        title: 'Event token (e.g. BuildStargate, ResearchBlink). Must match data exactly.',
        onChange: function (e) { s.updateRule(idx, { name: e.target.value.trim() }); },
      }),
      c('span', { className: 'text-[10px] text-neutral-500' }, 'by'),
      renderTimeField(rule, idx, s),
      c('button', {
        className: 'text-neutral-500 hover:text-loss-500 px-1', 'aria-label': 'Remove ' + rule.name,
        onClick: function () { s.removeRule(idx); },
      }, '×')
    );
  }

  function renderCycleBadge(rule, idx, s, isCount) {
    var icon = H.RULE_TYPE_ICON[rule.type] || '?';
    var label = H.RULE_TYPE_LABEL[rule.type] || '';
    var color = H.RULE_TYPE_COLOR[rule.type] || 'bg-base-700 text-neutral-200 border-base-600';
    var tooltip = 'Click to cycle rule type (currently: ' + rule.type.replace('_', ' ') + ')';
    if (isCount) {
      // Single combined badge: e.g. "≤ 16" — count is editable inline.
      return c('span', { className: 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ' + color, title: tooltip },
        c('button', { className: 'font-semibold leading-none', 'aria-label': 'Cycle type',
          onClick: function () { s.cycleRule(idx); }
        }, icon),
        renderCountField(rule, idx, s)
      );
    }
    // Single button: "✓ built by" / "✗ NOT by"
    return c('button', {
      className: 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-medium ' + color,
      title: tooltip, 'aria-label': 'Cycle type',
      onClick: function () { s.cycleRule(idx); }
    }, c('span', { className: 'font-semibold leading-none' }, icon),
       c('span', { className: 'text-[10px]' }, label)
    );
  }

  function renderTimeField(rule, idx, s) {
    var editing = s.editingTimeIdx === idx;
    if (editing) {
      return c('input', {
        type: 'text', defaultValue: H.formatTime(rule.time_lt),
        className: 'w-14 bg-base-800 border border-accent-500 rounded px-1 text-neutral-100 text-[11px] tabular-nums',
        autoFocus: true,
        onBlur: function (e) { s.commitTimeEdit(idx, e.target.value); },
        onKeyDown: function (e) {
          if (e.key === 'Enter') { e.preventDefault(); s.commitTimeEdit(idx, e.target.value); }
          else if (e.key === 'Escape') { s.setEditingTimeIdx(-1); }
        },
        onWheel: function (e) {
          e.preventDefault();
          var cur = H.parseTimeInput(e.target.value);
          if (cur != null) { var d = e.deltaY < 0 ? 5 : -5; e.target.value = H.formatTime(H.clampRuleTime(cur + d)); }
        },
      });
    }
    return c('button', {
      className: 'font-mono text-[11px] text-accent-400 hover:text-accent-500 underline decoration-dotted underline-offset-2 tabular-nums',
      title: 'Click to edit (type 3:30 or 210 or use scroll wheel)',
      onClick: function () { s.setEditingTimeIdx(idx); },
    }, H.formatTime(rule.time_lt));
  }

  function renderCountField(rule, idx, s) {
    // Stage 7.5b: always render as <input> — earlier the count was a
    // button-that-becomes-input-on-click, which felt like a double-click
    // (click 1 swapped the element, click 2 placed cursor). Now: one
    // click focuses + selects, type to overwrite, scroll wheel adjusts.
    var lo = rule.type === 'count_min' ? 1 : 0;
    return c('input', {
      type: 'number', min: lo, max: H.COUNT_MAX, value: rule.count, step: 1,
      className: 'w-12 bg-base-900/60 border border-accent-500/60 rounded px-1 text-accent-300 text-[11px] tabular-nums font-mono text-center focus:border-accent-500 focus:outline-none cursor-text hover:bg-base-900',
      title: 'Type or scroll-wheel to change count (' + lo + '–' + H.COUNT_MAX + ')',
      'aria-label': 'Count for ' + rule.name,
      onClick: function (e) { e.stopPropagation(); e.target.select(); },
      onChange: function (e) {
        var n = parseInt(e.target.value, 10);
        if (!isNaN(n)) s.updateRule(idx, { count: Math.max(lo, H.clampCount(n)) });
      },
      onWheel: function (e) {
        e.preventDefault();
        var delta = e.deltaY < 0 ? 1 : -1;
        var next = Math.max(lo, H.clampCount((rule.count || 0) + delta));
        s.updateRule(idx, { count: next });
      },
    });
  }

  // =====================================================================
  // Sticky save bar + toasts
  // =====================================================================
  function renderSaveBar(s) {
    var saveDisabled = s.saving || s.previewLoading || s.rules.length === 0 || s.reclassifyProgress;
    return c('div', { className: 'sticky bottom-0 flex items-center gap-3 px-5 py-3 border-t border-base-700 bg-base-900/95' },
      s.saveError ? c('span', { className: 'text-[11px] text-loss-500', 'aria-live': 'polite' }, s.saveError) : null,
      s.reclassifyProgress
        ? c('span', { className: 'text-[11px] text-neutral-400' },
            'Reclassifying ' + (s.reclassifyProgress.processed || 0) + ' / ' + (s.reclassifyProgress.total || '?') + '…')
        : null,
      c('button', {
        className: 'ml-auto px-3 py-1.5 rounded bg-base-700 text-neutral-300 hover:opacity-90 disabled:opacity-50',
        onClick: s.attemptClose, disabled: s.saving,
      }, 'Cancel'),
      c('button', {
        className: 'px-3 py-1.5 rounded bg-accent-500 text-white hover:opacity-90 disabled:opacity-50',
        onClick: function () { s.postSave(false); }, disabled: saveDisabled,
        title: s.previewLoading ? 'Wait for preview to settle…' : '',
      }, s.saving ? 'Saving…' : 'Save build'),
      c('button', {
        className: 'px-3 py-1.5 rounded bg-accent-500 text-white hover:opacity-90 disabled:opacity-50',
        onClick: function () { s.postSave(true); }, disabled: saveDisabled,
      }, s.saving ? 'Saving…' : 'Save & Reclassify')
    );
  }

  function renderToasts(toasts) {
    if (!toasts.length) return null;
    return c('div', {
      className: 'fixed bottom-3 right-3 flex flex-col gap-1 z-[60] pointer-events-none',
      'aria-live': 'polite',
    }, toasts.map(function (t) {
      var color = t.kind === 'success' ? 'bg-accent-500' : t.kind === 'error' ? 'bg-loss-500' : 'bg-amber-500';
      return c('div', { key: t.id,
        className: 'pointer-events-auto text-xs text-white px-3 py-1.5 rounded shadow ' + color },
        t.text,
        t.action ? c('a', { className: 'ml-2 underline', href: t.action.href }, t.action.label) : null);
    }));
  }

  // Expose
  window.BuildEditorModal = BuildEditorModal;
})();
