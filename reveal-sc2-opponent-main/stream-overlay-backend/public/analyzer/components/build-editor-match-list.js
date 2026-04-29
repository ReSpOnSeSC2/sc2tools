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
    return c(React.Fragment, { key: idx },
      c('li', { className: 'flex items-center gap-2 px-3 py-1.5 text-xs' },
        c('span', { className: 'text-neutral-500 font-mono tabular-nums w-8 text-right' }, '#' + (idx + 1)),
        m.game_id ? c('button', {
          className: 'text-neutral-500 hover:text-neutral-200 px-1',
          title: expanded ? 'Hide events' : "Inspect this game's events",
          'aria-expanded': expanded,
          onClick: function () { s.toggleInspect(m.game_id); },
        }, expanded ? '▼' : '▶') : c('span', { className: 'w-4' }),
        c('span', { className: 'text-neutral-100 flex-1 truncate' }, m.build_name),
        c('span', { className: 'text-neutral-500 font-mono tabular-nums truncate max-w-[140px] text-[10px]' }, m.game_id || '—'),
        isAlmost
          ? c('span', { className: 'text-loss-500 truncate max-w-[200px]' }, '✗ ' + (m.failed_reason || '?'))
          : c('span', { className: 'text-accent-500 font-mono tabular-nums' }, '✓ ' + ruleCount + '/' + ruleCount),
        m.game_id ? c('button', {
          className: 'text-neutral-500 hover:text-loss-500 px-1',
          title: 'Hide from list (does not change rules)',
          'aria-label': 'Hide ' + m.build_name,
          onClick: function () { s.hideMatch(m.game_id); },
        }, '×') : null
      ),
      expanded ? c('li', { className: 'px-6 py-2 bg-base-800/60 text-[11px] border-t border-base-700' },
        loading ? c('div', { className: 'text-neutral-500' }, 'Loading game events…')
        : !events ? c('div', { className: 'text-neutral-500' }, 'No events available.')
        : c('div', { className: 'grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-0.5 max-h-[180px] overflow-y-auto' },
            events.slice(0, 36).map(function (e, j) {
              return c('div', { key: j, className: 'flex items-center gap-2' },
                c('span', { className: 'font-mono text-neutral-500 w-10 tabular-nums text-[10px]' },
                  e.time_display || H.formatTime(e.time)),
                c('span', { className: 'truncate text-neutral-200' }, e.display || e.name)
              );
            }))
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
