/**
 * Stage 7.5 — Build editor modal (JSX, loaded by babel-standalone).
 *
 * Loaded with `<script type="text/babel" src="...">`. Reads helpers from
 * `window.BuildEditorHelpers` (build-editor-helpers.js, plain JS).
 *
 * The modal walks four sections — Basics, Signature events, Match
 * preview, Save bar — and posts to /api/custom-builds/{from-game,
 * preview-matches,/,reclassify}. Share-with-community is implicit:
 * created builds default to sync_state='pending' and the community_sync
 * service syncs them every 15min, plus a save-with-share-on triggers
 * an immediate /sync push.
 *
 * Attaches `window.BuildEditorModal` for the inline JSX in index.html
 * to mount as `<BuildEditorModal open={...} ... />`.
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
  var useCallback = React.useCallback;
  var H = window.BuildEditorHelpers;
  if (!H) {
    console.error('[build-editor-modal] BuildEditorHelpers missing');
    return;
  }

  var API = (window.location && window.location.origin) || '';
  var PREVIEW_DEBOUNCE_MS = 300;
  var TOAST_TTL_MS = 6000;
  var RACE_OPTIONS = ['Protoss', 'Terran', 'Zerg'];
  var VS_RACE_OPTIONS = ['Protoss', 'Terran', 'Zerg', 'Random', 'Any'];
  var TIER_OPTIONS = [null, 'S', 'A', 'B', 'C'];

  // ---------------------------------------------------------------------
  // Top-level component
  // ---------------------------------------------------------------------
  function BuildEditorModal(props) {
    var open = !!props.open;
    var game = props.game || {};
    var gameId = props.gameId || game.game_id || '';
    var initialDraft = props.draft || null;
    var profileReady = props.profileReady !== false;
    var onClose = props.onClose || function () {};
    var onSaved = props.onSaved || function () {};
    var socket = props.socket || (typeof window !== 'undefined' ? window.__sc2_socket : null);

    var rows = useMemo(function () {
      return H.spaEventsToRows(game.events || []);
    }, [game]);

    var initialCheckedKeys = useMemo(function () {
      if (initialDraft && Array.isArray(initialDraft.signature) && initialDraft.signature.length) {
        var keys = new Set();
        var byToken = new Map();
        for (var i = 0; i < rows.length; i += 1) {
          if (!byToken.has(rows[i].what)) byToken.set(rows[i].what, rows[i].key);
        }
        for (var j = 0; j < initialDraft.signature.length; j += 1) {
          var what = initialDraft.signature[j].what;
          var k = byToken.get(what);
          if (k) keys.add(k);
        }
        return keys;
      }
      return H.autoPickRowKeys(rows);
    }, [rows, initialDraft]);

    var initialWeights = useMemo(function () {
      var out = {};
      if (initialDraft && Array.isArray(initialDraft.signature)) {
        var byToken = new Map();
        for (var i = 0; i < rows.length; i += 1) byToken.set(rows[i].what, rows[i].key);
        for (var j = 0; j < initialDraft.signature.length; j += 1) {
          var s = initialDraft.signature[j];
          var k = byToken.get(s.what);
          if (k) out[k] = s.weight;
        }
      }
      return out;
    }, [rows, initialDraft]);

    var defaultName = useMemo(function () {
      if (initialDraft && initialDraft.name) return initialDraft.name;
      return H.deriveDefaultName(game);
    }, [game, initialDraft]);

    // ---- Editable state -----------------------------------------------
    var [name, setName] = useState(defaultName);
    var [description, setDescription] = useState((initialDraft && initialDraft.description) || '');
    var [race, setRace] = useState((initialDraft && initialDraft.race) || game.my_race || 'Protoss');
    var [vsRace, setVsRace] = useState((initialDraft && initialDraft.vs_race) || game.opp_race || 'Random');
    var [tier, setTier] = useState((initialDraft && initialDraft.tier) || null);
    var [tolerance, setTolerance] = useState(H.clampTolerance((initialDraft && initialDraft.tolerance_sec) || H.DEFAULT_TOLERANCE_SEC));
    var [minMatchScore, setMinMatchScore] = useState(H.clampMinMatchScore((initialDraft && initialDraft.min_match_score) || H.DEFAULT_MIN_MATCH_SCORE));
    var [winConditions, setWinConditions] = useState((initialDraft && initialDraft.win_conditions) || []);
    var [losesTo, setLosesTo] = useState((initialDraft && initialDraft.loses_to) || []);
    var [transitionsInto, setTransitionsInto] = useState((initialDraft && initialDraft.transitions_into) || []);
    var [shareWithCommunity, setShareWithCommunity] = useState(true);
    var [showStrategyNotes, setShowStrategyNotes] = useState(false);
    var [checkedKeys, setCheckedKeys] = useState(initialCheckedKeys);
    var [weightByKey, setWeightByKey] = useState(initialWeights);
    var [timeNudgeByKey, setTimeNudgeByKey] = useState({});
    // Stage 7.5: which signature rows have their advanced (weight +
    // time-nudge) sliders revealed. Default: all collapsed.
    var [expandedRows, setExpandedRows] = useState(function () { return new Set(); });
    // Stage 7.5: pagination index for the match-preview list (page size 5).
    // Reset to 0 whenever the previewResult identity changes so the user
    // never lands on a non-existent page after editing the signature.
    var [previewPage, setPreviewPage] = useState(0);
    var [previewResult, setPreviewResult] = useState(null);
    var [previewLoading, setPreviewLoading] = useState(false);
    var [previewError, setPreviewError] = useState(null);
    var [saving, setSaving] = useState(false);
    var [saveError, setSaveError] = useState(null);
    var [errors, setErrors] = useState({});
    var [reclassifyProgress, setReclassifyProgress] = useState(null);
    var [toasts, setToasts] = useState([]);
    var [confirmingClose, setConfirmingClose] = useState(false);

    var containerRef = useRef(null);
    var previousActiveRef = useRef(null);
    var pristineRef = useRef(null);
    var debouncedPreviewRef = useRef(null);

    // Capture the pristine state on first open so close-with-confirm works.
    useEffect(function () {
      if (!open) return;
      pristineRef.current = JSON.stringify({
        name: defaultName, description: (initialDraft && initialDraft.description) || '',
        race: race, vsRace: vsRace, tier: tier, tolerance: tolerance,
        minMatchScore: minMatchScore, checkedKeys: Array.from(initialCheckedKeys).sort(),
        weightByKey: initialWeights, timeNudgeByKey: {},
        winConditions: winConditions, losesTo: losesTo, transitionsInto: transitionsInto,
      });
    }, [open]);

    // Body scroll lock + focus capture/restore.
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

    // Esc + Tab key handler.
    var trap = useMemo(function () {
      return H.makeFocusTrap(containerRef.current);
    }, [containerRef.current]);
    useEffect(function () {
      if (!open) return undefined;
      function onKey(ev) {
        if (ev.key === 'Escape') {
          ev.stopPropagation();
          attemptClose();
        } else if (ev.key === 'Tab') {
          if (trap(ev)) ev.preventDefault();
        }
      }
      window.addEventListener('keydown', onKey, true);
      return function () { window.removeEventListener('keydown', onKey, true); };
    }, [open, trap, name, description, checkedKeys, weightByKey, timeNudgeByKey]);

    // Build the candidate signature on every relevant state change.
    var signature = useMemo(function () {
      return H.buildSignatureFromRows(rows, checkedKeys, weightByKey, timeNudgeByKey);
    }, [rows, checkedKeys, weightByKey, timeNudgeByKey]);

    // Debounced preview-matches POST.
    useEffect(function () {
      if (!open) return undefined;
      if (signature.length === 0) {
        setPreviewResult({ matches: [], scanned_games: 0, truncated: false });
        return undefined;
      }
      setPreviewError(null);
      var fn = H.debounce(function () {
        setPreviewLoading(true);
        fetch(API + '/api/custom-builds/preview-matches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            signature: signature,
            tolerance_sec: tolerance,
            min_match_score: minMatchScore,
            race: race, vs_race: vsRace,
          }),
        }).then(function (r) {
          return r.ok ? r.json() : r.json().then(function (j) { return Promise.reject(j); });
        }).then(function (j) {
          setPreviewResult(j);
          setPreviewLoading(false);
        }).catch(function (e) {
          setPreviewError((e && e.error) || 'preview failed');
          setPreviewLoading(false);
        });
      }, PREVIEW_DEBOUNCE_MS);
      debouncedPreviewRef.current = fn;
      fn();
      return function () { if (fn.cancel) fn.cancel(); };
    }, [open, signature, tolerance, minMatchScore, race, vsRace]);

    // Stage 7.5: reset pagination whenever the preview returns a new
    // result set so the user isn't stranded on an out-of-range page.
    useEffect(function () {
      setPreviewPage(0);
    }, [previewResult]);

    // Socket.io reclassify_progress.
    useEffect(function () {
      if (!open || !socket || typeof socket.on !== 'function') return undefined;
      function onProgress(payload) { setReclassifyProgress(payload || null); }
      socket.on('reclassify_progress', onProgress);
      return function () { socket.off && socket.off('reclassify_progress', onProgress); };
    }, [open, socket]);

    // ---- Helpers ------------------------------------------------------
    function pushToast(kind, text, action) {
      var id = Date.now() + Math.random();
      setToasts(function (xs) { return xs.concat([{ id: id, kind: kind, text: text, action: action }]); });
      setTimeout(function () {
        setToasts(function (xs) { return xs.filter(function (t) { return t.id !== id; }); });
      }, TOAST_TTL_MS);
    }

    function isDirty() {
      var current = JSON.stringify({
        name: name, description: description, race: race, vsRace: vsRace, tier: tier,
        tolerance: tolerance, minMatchScore: minMatchScore,
        checkedKeys: Array.from(checkedKeys).sort(), weightByKey: weightByKey,
        timeNudgeByKey: timeNudgeByKey, winConditions: winConditions,
        losesTo: losesTo, transitionsInto: transitionsInto,
      });
      return current !== pristineRef.current;
    }

    function attemptClose() {
      if (!isDirty() || confirmingClose) {
        setConfirmingClose(false);
        onClose();
        return;
      }
      setConfirmingClose(true);
      pushToast('warn', 'Unsaved changes — press Esc again or click X to discard.');
    }

    function toggleRow(key) {
      setCheckedKeys(function (prev) {
        var next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }

    function setRowWeight(key, w) {
      setWeightByKey(function (prev) {
        var next = Object.assign({}, prev);
        next[key] = H.clampWeight(w);
        return next;
      });
    }

    function setRowNudge(key, n) {
      setTimeNudgeByKey(function (prev) {
        var next = Object.assign({}, prev);
        next[key] = H.clampTimeNudge(n);
        return next;
      });
    }

    function toggleExpand(key) {
      setExpandedRows(function (prev) {
        var next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }

    function buildPayload() {
      return H.sanitiseDraft({
        name: name, description: description, race: race, vs_race: vsRace,
        tier: tier, win_conditions: winConditions, loses_to: losesTo,
        transitions_into: transitionsInto, signature: signature,
        tolerance_sec: tolerance, min_match_score: minMatchScore,
        source_replay_id: gameId || null,
      });
    }

    function postSave(thenReclassify) {
      var sanitised = buildPayload();
      if (!sanitised.ok) {
        setErrors(sanitised.errors);
        pushToast('error', 'Fix the highlighted fields before saving.');
        return;
      }
      setErrors({});
      setSaving(true);
      setSaveError(null);
      fetch(API + '/api/custom-builds/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sanitised.payload),
      }).then(function (r) {
        return r.ok ? r.json() : r.json().then(function (j) { return Promise.reject(j); });
      }).then(function (saved) {
        setSaving(false);
        pristineRef.current = JSON.stringify(stateForPristine());
        pushToast('success', 'Saved “' + saved.name + '”.', {
          label: 'View build', href: '/builds/' + saved.id,
        });
        if (shareWithCommunity) {
          fetch(API + '/api/custom-builds/sync', { method: 'POST' }).then(function () {
            pushToast('success', 'Shared with community.');
          }).catch(function () { /* sync failures are non-fatal; the periodic syncer will retry */ });
        }
        onSaved(saved);
        if (thenReclassify) doReclassify();
        else onClose();
      }).catch(function (e) {
        setSaving(false);
        var detail = (e && e.error) || 'save failed';
        setSaveError(detail);
        pushToast('error', 'Save failed: ' + detail);
      });
    }

    function stateForPristine() {
      return {
        name: name, description: description, race: race, vsRace: vsRace, tier: tier,
        tolerance: tolerance, minMatchScore: minMatchScore,
        checkedKeys: Array.from(checkedKeys).sort(), weightByKey: weightByKey,
        timeNudgeByKey: timeNudgeByKey, winConditions: winConditions,
        losesTo: losesTo, transitionsInto: transitionsInto,
      };
    }

    function doReclassify() {
      setReclassifyProgress({ processed: 0, total: 0, changed: 0 });
      fetch(API + '/api/custom-builds/reclassify', { method: 'POST' })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (j) { return Promise.reject(j); }); })
        .then(function (summary) {
          setReclassifyProgress(null);
          pushToast('success', 'Reclassified ' + (summary.scanned || 0) + ' games (' + (summary.changed || 0) + ' moved).');
          onClose();
        }).catch(function (e) {
          setReclassifyProgress(null);
          pushToast('error', 'Reclassify failed: ' + ((e && e.error) || 'unknown'));
        });
    }

    if (!open) return null;

    // ---- Render -------------------------------------------------------
    return React.createElement('div', {
      className: 'fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4',
      role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Save as new build',
      onClick: function (ev) { if (ev.target === ev.currentTarget) attemptClose(); },
    },
      React.createElement('div', {
        ref: containerRef,
        className: 'w-full max-w-5xl max-h-[92vh] flex flex-col bg-base-900 ring-soft rounded-lg border border-base-700 shadow-xl',
      },
        renderHeader(name, attemptClose, !profileReady),
        renderBody({
          // basics
          name: name, setName: setName, description: description, setDescription: setDescription,
          race: race, setRace: setRace, vsRace: vsRace, setVsRace: setVsRace,
          tier: tier, setTier: setTier, tolerance: tolerance, setTolerance: setTolerance,
          minMatchScore: minMatchScore, setMinMatchScore: setMinMatchScore,
          shareWithCommunity: shareWithCommunity, setShareWithCommunity: setShareWithCommunity,
          showStrategyNotes: showStrategyNotes, setShowStrategyNotes: setShowStrategyNotes,
          winConditions: winConditions, setWinConditions: setWinConditions,
          losesTo: losesTo, setLosesTo: setLosesTo,
          transitionsInto: transitionsInto, setTransitionsInto: setTransitionsInto,
          // signature
          rows: rows, checkedKeys: checkedKeys, weightByKey: weightByKey,
          timeNudgeByKey: timeNudgeByKey, signature: signature,
          toggleRow: toggleRow, setRowWeight: setRowWeight, setRowNudge: setRowNudge,
          expandedRows: expandedRows, toggleExpand: toggleExpand,
          // preview
          previewResult: previewResult, previewLoading: previewLoading, previewError: previewError,
          previewPage: previewPage, setPreviewPage: setPreviewPage,
          // errors / state
          errors: errors, profileReady: profileReady,
          // reclassify
          reclassifyProgress: reclassifyProgress,
        }),
        renderSaveBar({
          attemptClose: attemptClose, postSave: postSave, saving: saving, previewLoading: previewLoading,
          saveError: saveError, signature: signature,
        }),
        renderToasts(toasts)
      )
    );
  }

  // ---------------------------------------------------------------------
  // Sub-renderers (kept tiny to respect the 60-line function cap)
  // ---------------------------------------------------------------------
  function renderHeader(name, onCloseClick, showProfileWarn) {
    return React.createElement('div', { className: 'flex items-center gap-3 px-5 py-3 border-b border-base-700' },
      React.createElement('span', { className: 'text-[11px] uppercase tracking-wider text-neutral-500' }, 'Save as new build'),
      React.createElement('span', { className: 'text-sm text-neutral-200 truncate' }, name || 'Untitled'),
      showProfileWarn ? React.createElement('span', {
        className: 'text-[10px] text-amber-400 ml-2',
        title: 'Set up your profile in /settings to attribute community uploads.',
      }, 'profile.json missing') : null,
      React.createElement('button', {
        className: 'ml-auto text-neutral-400 hover:text-neutral-100',
        'aria-label': 'Close',
        onClick: onCloseClick,
      }, '✕')
    );
  }

  function renderBody(s) {
    return React.createElement('div', {
      className: 'flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-6',
    },
      renderSection1Basics(s),
      renderSection2Signature(s),
      renderSection3Preview(s)
    );
  }

  function renderSection1Basics(s) {
    var fieldClass = 'w-full bg-base-800 border border-base-700 rounded px-2 py-1 text-sm text-neutral-100 focus:outline-none focus:ring-1 focus:ring-accent-500';
    return React.createElement('section', { 'aria-label': 'Basics' },
      React.createElement('h3', { className: 'text-xs uppercase text-neutral-500 mb-2' }, '1 · Basics'),
      React.createElement('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-3' },
        renderField('Name', s.errors.name,
          React.createElement('input', {
            className: fieldClass, type: 'text', value: s.name, maxLength: H.NAME_MAX_CHARS,
            'aria-required': 'true',
            onChange: function (e) { s.setName(e.target.value); },
          })
        ),
        renderField('Tier', null,
          React.createElement('select', {
            className: fieldClass, value: s.tier || '',
            onChange: function (e) { s.setTier(e.target.value || null); },
          },
            TIER_OPTIONS.map(function (t) {
              return React.createElement('option', { key: t || 'none', value: t || '' }, t || '— none —');
            })
          )
        ),
        renderField('Race', null,
          React.createElement('select', { className: fieldClass, value: s.race, onChange: function (e) { s.setRace(e.target.value); } },
            RACE_OPTIONS.map(function (r) { return React.createElement('option', { key: r, value: r }, r); }))
        ),
        renderField('Vs race', null,
          React.createElement('select', { className: fieldClass, value: s.vsRace, onChange: function (e) { s.setVsRace(e.target.value); } },
            VS_RACE_OPTIONS.map(function (r) { return React.createElement('option', { key: r, value: r }, r); }))
        ),
        renderField('Tolerance: \u00b1' + s.tolerance + 's', null,
          React.createElement('div', null,
            React.createElement('input', {
              className: 'w-full', type: 'range', min: 5, max: 60, value: s.tolerance,
              title: 'Per-event match window. A signature event matches a game-event if their times are within \u00b1tolerance seconds. Larger = more games match.',
              onChange: function (e) { s.setTolerance(H.clampTolerance(e.target.value)); },
            }),
            React.createElement('div', { className: 'text-[10px] text-neutral-500 leading-tight' },
              'How loose timing has to be. \u00b1' + s.tolerance + 's means each event matches if its time is within ' + s.tolerance + ' seconds of yours.'
            )
          )
        ),
        renderField('Match strictness: ' + Math.round(s.minMatchScore * 100) + '%', null,
          React.createElement('div', null,
            React.createElement('input', {
              className: 'w-full', type: 'range', min: 0.3, max: 1.0, step: 0.05, value: s.minMatchScore,
              title: 'A game qualifies as a match when its weighted score reaches this fraction of the signature\u2019s total weight. 100% = every event must match; 50% = half is enough.',
              onChange: function (e) { s.setMinMatchScore(H.clampMinMatchScore(e.target.value)); },
            }),
            React.createElement('div', { className: 'text-[10px] text-neutral-500 leading-tight' },
              'How strict the match has to be. ' + Math.round(s.minMatchScore * 100) + '% of the signature\u2019s weight must land within tolerance.'
            )
          )
        )
      ),
      React.createElement('div', { className: 'mt-3' },
        renderField('Description (' + (s.description.length) + '/' + H.DESC_MAX_CHARS + ')', null,
          React.createElement('textarea', {
            className: fieldClass + ' h-20 resize-none', maxLength: H.DESC_MAX_CHARS,
            value: s.description,
            onChange: function (e) { s.setDescription(e.target.value); },
          })
        )
      ),
      // Inlined: Share toggle + Strategy notes (single call site each)
      React.createElement('label', { className: 'flex items-start gap-2 mt-3 cursor-pointer' },
        React.createElement('input', {
          type: 'checkbox', className: 'mt-1', checked: s.shareWithCommunity,
          onChange: function (e) { s.setShareWithCommunity(e.target.checked); },
        }),
        React.createElement('span', { className: 'text-sm text-neutral-300' },
          React.createElement('span', null, 'Share with community'),
          React.createElement('span', { className: 'block text-[10px] text-neutral-500' },
            'Visible to all players. ',
            React.createElement('a', { href: '/settings#privacy', className: 'underline hover:text-neutral-300' }, 'Privacy details')
          )
        )
      ),
      React.createElement('div', { className: 'mt-3' },
        React.createElement('button', {
          type: 'button', className: 'text-xs text-neutral-400 hover:text-neutral-200',
          'aria-expanded': s.showStrategyNotes,
          onClick: function () { s.setShowStrategyNotes(!s.showStrategyNotes); },
        }, (s.showStrategyNotes ? '▾' : '▸') + ' Strategy notes (optional)'),
        s.showStrategyNotes ? React.createElement('div', { className: 'mt-2 grid grid-cols-1 md:grid-cols-3 gap-3' },
          renderChipsField('Win conditions', s.winConditions, s.setWinConditions),
          renderChipsField('Loses to', s.losesTo, s.setLosesTo),
          renderChipsField('Transitions into', s.transitionsInto, s.setTransitionsInto)
        ) : null
      )
    );
  }

  function renderChipsField(label, list, setList) {
    return React.createElement('div', null,
      React.createElement('label', { className: 'text-[10px] uppercase tracking-wider text-neutral-500' }, label),
      React.createElement('div', { className: 'flex flex-wrap gap-1 mt-1' },
        list.map(function (item, i) {
          return React.createElement('span', {
            key: i,
            className: 'text-[11px] bg-base-800 rounded px-1.5 py-0.5 text-neutral-200 border border-base-700',
          },
            item,
            React.createElement('button', {
              className: 'ml-1 text-neutral-500 hover:text-neutral-200',
              'aria-label': 'Remove ' + item,
              onClick: function () { setList(list.filter(function (_, j) { return j !== i; })); },
            }, '×')
          );
        }),
        list.length < H.STRATEGY_NOTE_MAX_ITEMS ? React.createElement('input', {
            className: 'flex-1 min-w-[80px] bg-base-800 border border-base-700 rounded px-1 py-0.5 text-[11px]',
          placeholder: '+ add',
          maxLength: H.STRATEGY_NOTE_MAX_CHARS,
          onKeyDown: function (e) {
            if (e.key === 'Enter' && e.target.value.trim()) {
              e.preventDefault();
              setList(list.concat([e.target.value.trim()]));
              e.target.value = '';
            }
          },
        }) : null
      )
    );
  }

  function renderField(label, error, control) {
    return React.createElement('div', null,
      React.createElement('label', { className: 'text-[10px] uppercase tracking-wider text-neutral-500' }, label),
      control,
      error ? React.createElement('div', {
        className: 'text-[11px] text-loss-500 mt-0.5', 'aria-live': 'polite',
      }, error) : null
    );
  }

  function renderSection2Signature(s) {
    var byKey = {};
    s.rows.forEach(function (r) { byKey[r.key] = r; });
    return React.createElement('section', { 'aria-label': 'Signature events' },
      React.createElement('h3', { className: 'text-xs uppercase text-neutral-500 mb-2' },
        '2 · Signature events ',
        React.createElement('span', { className: 'normal-case text-neutral-600' },
          '(' + s.checkedKeys.size + ' selected · max 60 · auto-pick takes top ' + H.AUTO_PICK_CAP + ' tech-defining)')
      ),
      s.errors.signature ? React.createElement('div', {
        className: 'text-[11px] text-loss-500 mb-2', 'aria-live': 'polite',
      }, s.errors.signature) : null,
      React.createElement('div', { className: 'grid grid-cols-1 lg:grid-cols-2 gap-3' },
        renderRowsList(s),
        renderSignaturePreviewList(s, byKey)
      )
    );
  }

  function renderRowsList(s) {
    return React.createElement('div', {
      className: 'bg-base-800/40 rounded border border-base-700 max-h-[360px] overflow-y-auto',
    },
      React.createElement('div', { className: 'sticky top-0 bg-base-800/90 px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-500 border-b border-base-700' },
        'Source game timeline (' + s.rows.length + ' events)'),
      s.rows.length === 0 ? React.createElement('div', { className: 'p-3 text-xs text-neutral-500' },
        'No mappable events on this game.') :
      React.createElement('ul', { className: 'divide-y divide-base-700' },
        s.rows.map(function (r) { return renderRowItem(r, s); }))
    );
  }

  function renderRowItem(r, s) {
    var checked = s.checkedKeys.has(r.key);
    return React.createElement('li', { key: r.key, className: 'flex items-center gap-2 px-3 py-1.5 text-xs' },
      React.createElement('input', {
        type: 'checkbox', checked: checked,
        'aria-label': 'Include ' + r.what,
        onChange: function () { s.toggleRow(r.key); },
      }),
      React.createElement('span', { className: 'font-mono text-[11px] text-neutral-400 w-10 tabular-nums' }, r.time_display),
      React.createElement('span', { className: 'flex-1 truncate text-neutral-200' }, r.display),
      React.createElement('span', { className: 'text-[10px] text-neutral-500 tabular-nums' }, r.what)
    );
  }

  function renderSignaturePreviewList(s, byKey) {
    return React.createElement('div', {
      className: 'bg-base-800/40 rounded border border-base-700 max-h-[360px] overflow-y-auto',
    },
      React.createElement('div', { className: 'sticky top-0 bg-base-800/90 px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-500 border-b border-base-700' },
        'Signature (' + s.signature.length + ') · click ⚙ to tweak weight/time'),
      s.signature.length === 0 ? React.createElement('div', { className: 'p-3 text-xs text-neutral-500' },
        'Tick events on the left to add them here.') :
      React.createElement('ul', { className: 'divide-y divide-base-700' },
        s.signature.map(function (sig, i) { return renderSignatureRow(sig, i, s); })
      )
    );
  }

  function renderSignatureRow(sig, i, s) {
    var keyForToken = null;
    for (var j = 0; j < s.rows.length; j += 1) {
      if (s.rows[j].what === sig.what && s.checkedKeys.has(s.rows[j].key)) {
        keyForToken = s.rows[j].key; break;
      }
    }
    var isExpanded = keyForToken && s.expandedRows && s.expandedRows.has(keyForToken);
    var w = s.weightByKey[keyForToken];
    if (w == null) w = H.AUTO_PICK_WEIGHT;
    var nudge = s.timeNudgeByKey[keyForToken] || 0;
    var displayT = H.formatTime(sig.t);
    return React.createElement('li', { key: i, className: 'px-3 py-1.5 text-xs space-y-1' },
      React.createElement('div', { className: 'flex items-center gap-2' },
        React.createElement('span', { className: 'font-mono text-[11px] text-neutral-400 w-10 tabular-nums' }, displayT),
        React.createElement('span', { className: 'flex-1 truncate text-neutral-100' }, sig.what),
        keyForToken ? React.createElement('button', {
          className: 'text-neutral-500 hover:text-neutral-200 px-1',
          'aria-label': (isExpanded ? 'Hide' : 'Show') + ' advanced for ' + sig.what,
          'aria-expanded': isExpanded ? 'true' : 'false',
          title: isExpanded ? 'Hide weight + time tweaks' : 'Tweak weight or time offset',
          onClick: function () { s.toggleExpand(keyForToken); },
        }, '⚙') : null,
        React.createElement('button', {
          className: 'text-neutral-500 hover:text-loss-500 px-1',
          'aria-label': 'Remove ' + sig.what,
          onClick: function () { if (keyForToken) s.toggleRow(keyForToken); },
        }, '×')
      ),
      isExpanded ? React.createElement('div', { className: 'pl-12 pr-1 space-y-1' },
        React.createElement('div', { className: 'flex items-center gap-2' },
          React.createElement('span', { className: 'text-[10px] text-neutral-500 w-14' }, 'weight'),
          React.createElement('input', {
            type: 'range', min: 0, max: 1, step: 0.05, value: w, className: 'flex-1',
            title: 'How much this event contributes to the match score. 1.0 = full weight, 0 = ignored. Most users leave at 1.0.',
            onChange: function (e) { s.setRowWeight(keyForToken, Number(e.target.value)); },
          }),
          React.createElement('span', { className: 'text-[10px] text-neutral-400 w-10 tabular-nums' }, w.toFixed(2))
        ),
        React.createElement('div', { className: 'flex items-center gap-2' },
          React.createElement('span', { className: 'text-[10px] text-neutral-500 w-14' }, 'time offset'),
          React.createElement('input', {
            type: 'range', min: -H.TIME_NUDGE_MAX_SEC, max: H.TIME_NUDGE_MAX_SEC, step: 1, value: nudge, className: 'flex-1',
            title: 'Shift this event\'s target time. Use only if your replay was atypical (e.g. delayed Stargate); otherwise leave at 0 and let global Tolerance handle drift.',
            onChange: function (e) { s.setRowNudge(keyForToken, Number(e.target.value)); },
          }),
          React.createElement('span', { className: 'text-[10px] text-neutral-400 w-10 tabular-nums' }, (nudge >= 0 ? '+' : '') + nudge + 's')
        )
      ) : null
    );
  }

  var PREVIEW_PAGE_SIZE = 5;

  function renderSection3Preview(s) {
    var pr = s.previewResult || { matches: [], scanned_games: 0, truncated: false };
    var matches = pr.matches || [];
    var totalPages = Math.max(1, Math.ceil(matches.length / PREVIEW_PAGE_SIZE));
    // Clamp page in case state hasn't caught up to a smaller result yet.
    var page = Math.min(Math.max(0, s.previewPage || 0), totalPages - 1);
    var pageStart = page * PREVIEW_PAGE_SIZE;
    var pageItems = matches.slice(pageStart, pageStart + PREVIEW_PAGE_SIZE);
    var msg;
    if (s.previewLoading) msg = 'Scoring against your games…';
    else if (s.previewError) msg = 'Preview error: ' + s.previewError;
    else msg = 'Matches ' + matches.length + (pr.truncated ? '+' : '') + ' of your ' + pr.scanned_games + ' games.';
    var hint = (matches.length === 0 && pr.scanned_games > 0 && !s.previewLoading)
      ? 'Try lowering match strictness or increasing tolerance.' : null;
    return React.createElement('section', { 'aria-label': 'Match preview' },
      React.createElement('h3', { className: 'text-xs uppercase text-neutral-500 mb-2' }, '3 · Match preview'),
      React.createElement('div', { className: 'text-sm text-neutral-200', 'aria-live': 'polite' }, msg),
      hint ? React.createElement('div', { className: 'text-[11px] text-neutral-500 mt-1' }, hint) : null,
      pageItems.length > 0 ? React.createElement('ul', {
        className: 'mt-2 divide-y divide-base-700 bg-base-800/40 rounded border border-base-700',
      },
        pageItems.map(function (m, i) {
          return React.createElement('li', { key: pageStart + i, className: 'flex items-center gap-3 px-3 py-1.5 text-xs' },
            React.createElement('span', { className: 'text-neutral-500 font-mono tabular-nums w-8 text-right' }, '#' + (pageStart + i + 1)),
            React.createElement('span', { className: 'text-neutral-100 flex-1 truncate' }, m.build_name),
            React.createElement('span', { className: 'text-neutral-500 font-mono tabular-nums truncate max-w-[180px]' }, m.game_id || '—'),
            React.createElement('span', { className: 'text-accent-500 font-mono tabular-nums w-12 text-right' }, (m.score * 100).toFixed(0) + '%')
          );
        })
      ) : null,
      matches.length > PREVIEW_PAGE_SIZE ? renderPreviewPager(s, page, totalPages, matches.length, pr.truncated) : null
    );
  }

  function renderPreviewPager(s, page, totalPages, matchCount, truncated) {
    var atFirst = page <= 0;
    var atLast = page >= totalPages - 1;
    var btnBase = 'px-2 py-0.5 rounded text-xs ';
    var btnEnabled = 'bg-base-700 text-neutral-200 hover:bg-base-600';
    var btnDisabled = 'bg-base-800 text-neutral-600 cursor-not-allowed';
    var totalLabel = truncated ? (totalPages + '+') : totalPages;
    return React.createElement('div', { className: 'mt-2 flex items-center justify-center gap-3 text-xs text-neutral-400' },
      React.createElement('button', {
        className: btnBase + (atFirst ? btnDisabled : btnEnabled),
        disabled: atFirst, 'aria-label': 'Previous page',
        onClick: function () { s.setPreviewPage(Math.max(0, page - 1)); },
      }, '← prev'),
      React.createElement('span', { className: 'tabular-nums select-none' },
        'page ' + (page + 1) + ' / ' + totalLabel + ' · ' + matchCount + (truncated ? '+' : '') + ' total'),
      React.createElement('button', {
        className: btnBase + (atLast ? btnDisabled : btnEnabled),
        disabled: atLast, 'aria-label': 'Next page',
        onClick: function () { s.setPreviewPage(Math.min(totalPages - 1, page + 1)); },
      }, 'next →')
    );
  }

  function renderSaveBar(s) {
    var saveDisabled = s.saving || s.previewLoading || s.signature.length === 0;
    return React.createElement('div', {
      className: 'sticky bottom-0 flex items-center gap-3 px-5 py-3 border-t border-base-700 bg-base-900/95',
    },
      s.saveError ? React.createElement('span', {
        className: 'text-[11px] text-loss-500', 'aria-live': 'polite',
      }, s.saveError) : null,
      React.createElement('button', {
        className: 'ml-auto px-3 py-1.5 rounded bg-base-700 text-neutral-300 hover:opacity-90 disabled:opacity-50',
        onClick: s.attemptClose, disabled: s.saving,
      }, 'Cancel'),
      React.createElement('button', {
        className: 'px-3 py-1.5 rounded bg-accent-500 text-white hover:opacity-90 disabled:opacity-50',
        onClick: function () { s.postSave(false); }, disabled: saveDisabled,
        title: s.previewLoading ? 'Wait for preview to settle…' : '',
      }, s.saving ? 'Saving…' : 'Save build'),
      React.createElement('button', {
        className: 'px-3 py-1.5 rounded bg-accent-500 text-white hover:opacity-90 disabled:opacity-50',
        onClick: function () { s.postSave(true); }, disabled: saveDisabled,
      }, s.saving ? 'Saving…' : 'Save & Reclassify')
    );
  }

  function renderToasts(toasts) {
    if (!toasts.length) return null;
    return React.createElement('div', {
      className: 'fixed bottom-3 right-3 flex flex-col gap-1 z-[60] pointer-events-none',
      'aria-live': 'polite',
    },
      toasts.map(function (t) {
        var color = t.kind === 'success' ? 'bg-accent-500' : t.kind === 'error' ? 'bg-loss-500' : 'bg-amber-500';
        return React.createElement('div', {
          key: t.id,
          className: 'pointer-events-auto text-xs text-white px-3 py-1.5 rounded shadow ' + color,
        },
          t.text,
          t.action ? React.createElement('a', {
            className: 'ml-2 underline', href: t.action.href,
          }, t.action.label) : null
        );
      })
    );
  }

  // Expose
  window.BuildEditorModal = BuildEditorModal;
})();
