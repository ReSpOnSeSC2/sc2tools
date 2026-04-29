/**
 * Stage 7.5b — Match-list renderer (Section 3 of the build editor).
 *
 * Extracted from build-editor-modal.js to keep that file under the
 * 800-line hard cap. Renders the preview matches + almost-matches with
 * inline inspect (▶ to expand a row's events) and hide (× to remove a
 * false-positive from the visible list). State (expandedMatch, hiddenMatches,
 * inspectCache, inspectLoading) lives in the parent modal and is plumbed
 * through the `s` object — same pattern as the other section renderers.
 *
 * Exposes window.BuildEditorMatchList.render(s).
 *
 * @module build-editor-match-list
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.React) return;
  var React = window.React;
  var c = React.createElement;
  var H = window.BuildEditorHelpers;
  if (!H) { console.error('[build-editor-match-list] BuildEditorHelpers missing'); return; }

  var PAGE_SIZE = 5;

  function render(s) {
    var pr = s.previewResult || { matches: [], almost_matches: [], scanned_games: 0, truncated: false };
    var matchesAll = pr.matches || [];
    var almostAll = pr.almost_matches || [];
    var matches = matchesAll.filter(function (m) { return !s.hiddenMatches.has(m.game_id); });
    var almost = almostAll.filter(function (m) { return !s.hiddenMatches.has(m.game_id); });
    var hiddenCount = (matchesAll.length - matches.length) + (almostAll.length - almost.length);
    var msg = banner(s, pr, matchesAll.length);
    return c('section', { 'aria-label': 'Match preview' },
      c('h3', { className: 'text-xs uppercase text-neutral-500 mb-2' }, '3 · Match preview'),
      c('div', { className: 'text-sm text-neutral-200', 'aria-live': 'polite' }, msg),
      hiddenCount > 0 ? c('div', { className: 'text-[11px] text-neutral-500 mt-1' },
        hiddenCount + ' hidden · ',
        c('button', { className: 'underline hover:text-neutral-300', onClick: s.unhideAll }, 'show all')
      ) : null,
      matches.length > 0 ? renderList('Matches', matches, s.previewPage, s.setPreviewPage, s.rules.length, false, s) : null,
      almost.length > 0 ? renderList('Almost matches — failed exactly 1 rule (click ▶ to inspect)',
        almost, s.almostPage, s.setAlmostPage, 0, true, s) : null
    );
  }

  function banner(s, pr, totalMatches) {
    if (s.previewLoading) return 'Scoring against your games…';
    if (s.previewError) return 'Preview error: ' + s.previewError;
    if (s.rules.length === 0) return 'Add a rule to see matches.';
    var pct = pr.scanned_games > 0 ? ((totalMatches / pr.scanned_games) * 100).toFixed(1) : '0.0';
    return '✓ ' + totalMatches + (pr.truncated ? '+' : '') + ' of your ' + pr.scanned_games +
      ' games match all ' + s.rules.length + ' rules (' + pct + '%).';
  }

  function renderList(label, items, page, setPage, ruleCount, isAlmost, s) {
    var totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    var p = Math.min(Math.max(0, page), totalPages - 1);
    var start = p * PAGE_SIZE;
    var pageItems = items.slice(start, start + PAGE_SIZE);
    return c('div', { className: 'mt-2' },
      c('div', { className: 'text-[10px] uppercase tracking-wider text-neutral-500 mb-1' }, label),
      c('ul', { className: 'divide-y divide-base-700 bg-base-800/40 rounded border border-base-700' },
        pageItems.map(function (m, i) { return renderRow(m, start + i, ruleCount, isAlmost, s); })),
      items.length > PAGE_SIZE ? renderPager(p, totalPages, items.length, setPage) : null
    );
  }

  function renderRow(m, idx, ruleCount, isAlmost, s) {
    var expanded = s.expandedMatch && s.expandedMatch === m.game_id;
    var loading = s.inspectLoading && s.inspectLoading[m.game_id];
    var events = s.inspectCache && s.inspectCache[m.game_id];
    var canInspect = !!m.game_id;
    var rowClass = 'flex items-center gap-2 px-3 py-1.5 text-xs ' +
      (canInspect ? 'cursor-pointer hover:bg-base-700/30' : '');
    return c(React.Fragment, { key: idx },
      c('li', {
        className: rowClass,
        title: canInspect ? (expanded ? 'Click to hide events' : 'Click to inspect this game\'s events') : '',
        onClick: canInspect ? function (ev) {
          // Don't trigger row-click when clicking the X button (handled separately)
          if (ev.target && ev.target.closest && ev.target.closest('[data-row-action]')) return;
          s.toggleInspect(m.game_id);
        } : null,
      },
        c('span', { className: 'text-neutral-500 font-mono tabular-nums w-8 text-right' }, '#' + (idx + 1)),
        canInspect ? c('span', {
          className: 'inline-flex items-center justify-center w-5 h-5 rounded text-accent-400 text-[11px] ' +
            (expanded ? 'bg-accent-500/20' : ''),
          'aria-hidden': 'true',
        }, expanded ? '▼' : '▶') : c('span', { className: 'w-5' }),
        c('span', { className: 'flex-1 truncate ' + (canInspect ? 'text-accent-300 underline decoration-dotted underline-offset-2' : 'text-neutral-100') }, m.build_name),
        c('span', { className: 'text-neutral-500 font-mono tabular-nums truncate max-w-[140px] text-[10px]' }, m.game_id || '—'),
        isAlmost
          ? c('span', { className: 'text-loss-500 truncate max-w-[200px]' }, '✗ ' + (m.failed_reason || '?'))
          : c('span', { className: 'text-accent-500 font-mono tabular-nums' }, '✓ ' + ruleCount + '/' + ruleCount),
        canInspect ? c('button', {
          'data-row-action': 'hide',
          className: 'text-neutral-500 hover:text-loss-500 px-1',
          title: 'Hide from list (does not change rules)',
          'aria-label': 'Hide ' + m.build_name,
          onClick: function (ev) { ev.stopPropagation(); s.hideMatch(m.game_id); },
        }, '×') : null
      ),
      expanded ? c('li', { className: 'px-6 py-2 bg-base-800/60 text-[11px] border-t border-base-700' },
        loading ? c('div', { className: 'text-neutral-500' }, 'Loading game events…')
        : !events ? c('div', { className: 'text-neutral-500' }, 'No events available.')
        : c('div', null,
            c('div', { className: 'text-[10px] text-neutral-500 mb-1' },
              'All ' + events.length + ' events from this game (scroll to see more):'),
            c('div', { className: 'grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-0.5 max-h-[320px] overflow-y-auto pr-1' },
              events.map(function (e, j) {
                // Highlight events that match any of the user's current rule names — makes it
                // immediately visible WHICH events triggered the match (e.g. BuildHighTemplar
                // appears in accent if there's a rule for it).
                var matched = s && s.rules && s.rules.some(function (r) {
                  return r && r.name && (e.name === r.name || ('Build' + (e.name || '')) === r.name || e.what === r.name);
                });
                var cls = 'flex items-center gap-2 ' + (matched ? 'bg-accent-500/10 rounded px-1' : '');
                return c('div', { key: j, className: cls },
                  c('span', { className: 'font-mono text-neutral-500 w-10 tabular-nums text-[10px]' },
                    e.time_display || H.formatTime(e.time)),
                  c('span', { className: 'truncate ' + (matched ? 'text-accent-400 font-medium' : 'text-neutral-200') },
                    e.display || e.name)
                );
              }))
          )
      ) : null
    );
  }

  function renderPager(page, totalPages, total, setPage) {
    var atFirst = page <= 0; var atLast = page >= totalPages - 1;
    var bb = 'px-2 py-0.5 rounded text-xs ';
    var on = 'bg-base-700 text-neutral-200 hover:bg-base-600';
    var off = 'bg-base-800 text-neutral-600 cursor-not-allowed';
    return c('div', { className: 'mt-2 flex items-center justify-center gap-3 text-xs text-neutral-400' },
      c('button', { className: bb + (atFirst ? off : on), disabled: atFirst,
        'aria-label': 'Previous page', onClick: function () { setPage(Math.max(0, page - 1)); } }, '← prev'),
      c('span', { className: 'tabular-nums select-none' },
        'page ' + (page + 1) + ' / ' + totalPages + ' · ' + total + ' total'),
      c('button', { className: bb + (atLast ? off : on), disabled: atLast,
        'aria-label': 'Next page', onClick: function () { setPage(Math.min(totalPages - 1, page + 1)); } }, 'next →')
    );
  }

  window.BuildEditorMatchList = { render: render };
})();
