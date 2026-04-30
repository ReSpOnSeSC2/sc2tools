/**
 * TrendsTab — extracted from index.html.
 *
 * Loaded from index.html via:
 *   <script type="text/babel" data-presets="react" src="..."></script>
 *
 * Babel-standalone compiles JSX in this file before execution.
 * The IIFE wrapper isolates lexical scope from the inline block in
 * index.html (which has its own `const { useState, ... } = React;`),
 * preventing redeclaration errors. Each exported component / helper
 * is attached to `window` at the bottom so the inline block's bare
 * JSX identifiers (e.g. `<FooBar />`) resolve via the global object
 * at render time.
 *
 * DO NOT EDIT THE EXTRACTED BODY HERE WITHOUT ALSO UPDATING THE
 * MATCHING SECTION IN index.html — the two MUST NOT BOTH EXIST.
 */
(function () {
  "use strict";
  const React = window.React;
  const { useState, useEffect, useMemo, useCallback, useRef, Fragment } = React;

      function TrendsTab({ filters, dbRev }) {
        const [bucket, setBucket] = useState("week");
        const params = useMemo(
          () => ({ ...filters, bucket }),
          [filters, bucket],
        );
        const { data, loading } = useApi("timeseries", params, [
          JSON.stringify(params),
          dbRev,
        ]);
        if (loading) return <Skeleton rows={4} />;
        const series = data || [];
        return (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-neutral-200">
                Trends
              </h2>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs uppercase text-neutral-500">
                  Bucket
                </span>
                <select
                  value={bucket}
                  onChange={(e) => setBucket(e.target.value)}
                  className="bg-base-700 ring-soft rounded px-2 py-1 text-sm"
                >
                  <option value="day">Day</option>
                  <option value="week">Week</option>
                  <option value="month">Month</option>
                </select>
              </div>
            </div>
            {series.length === 0 ? (
              <EmptyState />
            ) : (
              <Fragment>
                <Card title="Games per period (W stacked on L)">
                  <StackedBars data={series} height={240} />
                </Card>
                <Card title="Win rate trend">
                  <LinePath
                    data={series}
                    height={240}
                    valueKey="winRate"
                    yMax={1}
                  />
                </Card>
              </Fragment>
            )}
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    TrendsTab
  });
})();
