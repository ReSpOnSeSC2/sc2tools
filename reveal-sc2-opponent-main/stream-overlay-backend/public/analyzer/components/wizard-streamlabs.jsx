/**
 * Wizard streamlabs — extracted from index.html for size-rule compliance.
 *
 * Loaded from index.html via:
 *   <script type="text/babel" data-presets="react" src="..."></script>
 *
 * Babel-standalone compiles JSX in this file before execution.
 * The IIFE wrapper isolates lexical scope from the inline block in
 * index.html (which has its own `const { useState, ... } = React;`),
 * preventing redeclaration errors. Each exported component / helper
 * is attached to `window` at the bottom so the inline block's bare
 * JSX identifiers (e.g. `<SettingsView />`) resolve via the global
 * object at render time.
 *
 * DO NOT EDIT THE EXTRACTED BODY HERE WITHOUT ALSO UPDATING THE
 * MATCHING SECTION IN index.html — the two MUST NOT BOTH EXIST.
 */
(function () {
  "use strict";
  const React = window.React;
  const { useState, useEffect, useMemo, useCallback, useRef, Fragment } = React;

      function WizardWidgetRowHeader({ widget }) {
        return (
          <div style={{ display: "flex", alignItems: "baseline",
                        gap: "var(--space-2)",
                        marginBottom: "var(--space-1)" }}>
            <span style={{ fontWeight: 600,
                           color: "var(--color-text-primary)",
                           fontSize: "var(--font-size-sm)" }}>
              {widget.title}
            </span>
            {widget.recommended ? (
              <span style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--color-success)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}>recommended</span>
            ) : null}
            <span style={{ marginLeft: "auto",
                           fontSize: "var(--font-size-xs)",
                           color: "var(--color-text-muted)" }}>
              {widget.trigger} &middot; {widget.w}&times;{widget.h}
            </span>
          </div>
        );
      }

      function WizardCopyableUrl({ url }) {
        const [copied, setCopied] = useState(false);
        const onCopy = async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch (_e) { /* clipboard API may be blocked */ }
        };
        return (
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <code style={{
              flex: 1, fontFamily: "var(--font-family-mono)",
              fontSize: "var(--font-size-xs)",
              padding: "var(--space-1) var(--space-2)",
              background: "var(--color-bg-elevated)",
              color: "var(--color-text-primary)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-sm)",
              wordBreak: "break-all",
            }}>{url}</code>
            <WizardButton kind="secondary" onClick={onCopy}>
              {copied ? "Copied!" : "Copy"}
            </WizardButton>
          </div>
        );
      }

      function WizardWidgetRow({ widget, baseUrl }) {
        const url = baseUrl + "widgets/" + widget.file;
        return (
          <div style={{
            background: "var(--color-bg-primary)",
            border: widget.recommended
              ? "1px solid var(--color-success)"
              : "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-md)",
            padding: "var(--space-3)",
            marginBottom: "var(--space-2)",
          }}>
            <WizardWidgetRowHeader widget={widget} />
            <div style={{ fontSize: "var(--font-size-xs)",
                          color: "var(--color-text-secondary)",
                          marginBottom: "var(--space-2)",
                          lineHeight: "var(--line-height-relaxed)" }}>
              {widget.desc}
            </div>
            <WizardCopyableUrl url={url} />
          </div>
        );
      }

      function WizardStreamlabsToolbar({ showAll, onToggleShowAll,
                                              visibleCount, totalCount,
                                              onCopyAll, allCopied }) {
        return (
          <div style={{ display: "flex", gap: "var(--space-2)",
                        marginBottom: "var(--space-3)",
                        flexWrap: "wrap" }}>
            <WizardButton kind="secondary" onClick={onToggleShowAll}>
              {showAll ? "Show recommended only (4)"
                       : `Show all (${totalCount})`}
            </WizardButton>
            <WizardButton kind="secondary" onClick={onCopyAll}>
              {allCopied ? "Copied!" : `Copy all (${visibleCount})`}
            </WizardButton>
          </div>
        );
      }

      function WizardStreamlabsAllInOne() {
        return (
          <details style={{
            marginTop: "var(--space-3)",
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-secondary)",
          }}>
            <summary style={{ cursor: "pointer" }}>
              Or paste the all-in-one URL (every widget pinned in one
              fixed layout)
            </summary>
            <div style={{ marginTop: "var(--space-2)" }}>
              <WizardCopyBox value={WIZARD_OVERLAY_URL} />
              <p style={{ fontSize: "var(--font-size-xs)",
                          color: "var(--color-text-muted)" }}>
                Use this URL once at 1920&times;1080 if you don&apos;t
                want to manage individual widget sources. Less flexible
                but a one-click setup.
              </p>
            </div>
          </details>
        );
      }

      const WIZARD_STREAMLABS_HOWTO_STREAMLABS = [
        "In Streamlabs Desktop, click the + under Sources.",
        "Pick \"Browser Source\" (sometimes shown as \"Web Page\").",
        "Name it after the widget (e.g. \"SC2 Session\") and click Add Source.",
        "Paste that widget\u2019s URL into the URL field.",
        "Set Width and Height to the suggested values shown above.",
        "Tick \"Shutdown source when not visible\" to save resources.",
        "Tick \"Refresh browser when scene becomes active\".",
        "Click Done, then drag/resize the widget where you want it.",
        "Repeat for each widget you want.",
      ];
      const WIZARD_STREAMLABS_HOWTO_OBS = [
        "In OBS, click the + under Sources and pick \"Browser\".",
        "Name it after the widget and click OK.",
        "Paste that widget\u2019s URL into the URL field.",
        "Set Width and Height to the suggested values shown above.",
        "Tick \"Refresh browser when scene becomes active\".",
        "Click OK, then drag the source to where you want it.",
        "Repeat for each widget you want.",
      ];

      function useWizardStreamlabsState() {
        const [showAll, setShowAll] = useState(false);
        const [allCopied, setAllCopied] = useState(false);
        const visible = showAll
          ? WIZARD_OVERLAY_WIDGETS
          : WIZARD_OVERLAY_WIDGETS.filter((w) => w.recommended);
        const copyAllUrls = async () => {
          const urls = visible
            .map((w) => `${w.title}\t${WIZARD_OVERLAY_URL}widgets/${w.file}`)
            .join("\n");
          try {
            await navigator.clipboard.writeText(urls);
            setAllCopied(true);
            setTimeout(() => setAllCopied(false), 1500);
          } catch (_e) { /* clipboard API may be blocked */ }
        };
        return { showAll, setShowAll, visible, copyAllUrls, allCopied };
      }

      function WizardStreamlabsCard({ expanded, onToggle }) {
        const s = useWizardStreamlabsState();
        return (
          <WizardIntegrationCard title="Streamlabs / OBS Browser Source"
                                 expanded={expanded} onToggle={onToggle}>
            <p style={{ fontSize: "var(--font-size-sm)",
                        color: "var(--color-text-secondary)",
                        marginBottom: "var(--space-3)" }}>
              Each card below is its own Browser Source URL. Add only the
              widgets you want and drag them around your scene independently.
              The four <span style={{ color: "var(--color-success)" }}>
              RECOMMENDED</span> widgets cover most stream needs.
            </p>
            <WizardStreamlabsToolbar
              showAll={s.showAll}
              onToggleShowAll={() => s.setShowAll(!s.showAll)}
              visibleCount={s.visible.length}
              totalCount={WIZARD_OVERLAY_WIDGETS.length}
              onCopyAll={s.copyAllUrls}
              allCopied={s.allCopied} />
            {s.visible.map((w) => (
              <WizardWidgetRow key={w.file} widget={w}
                               baseUrl={WIZARD_OVERLAY_URL} />
            ))}
            <WizardStreamlabsAllInOne />
            <WizardHowTo title="How do I add a widget in Streamlabs Desktop?"
              steps={WIZARD_STREAMLABS_HOWTO_STREAMLABS} />
            <WizardHowTo title="How do I add a widget in OBS Studio?"
              steps={WIZARD_STREAMLABS_HOWTO_OBS} />
            <p style={{ fontSize: "var(--font-size-xs)",
                        color: "var(--color-text-muted)" }}>
              Tip: keep this app&apos;s server running while you stream.
              Widgets connect to it for live data and update whenever a
              new replay lands.
            </p>
          </WizardIntegrationCard>
        );
      }


  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    WizardWidgetRowHeader,
    WizardCopyableUrl,
    WizardWidgetRow,
    WizardStreamlabsToolbar,
    WizardStreamlabsAllInOne,
    WIZARD_STREAMLABS_HOWTO_STREAMLABS,
    WIZARD_STREAMLABS_HOWTO_OBS,
    useWizardStreamlabsState,
    WizardStreamlabsCard
  });
})();
