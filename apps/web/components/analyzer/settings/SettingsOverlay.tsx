"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  Plus,
  Copy,
  Trash2,
  Tv,
  Check,
  AlertTriangle,
  Play,
  Square,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { fmtAgo } from "@/lib/format";
import { TEST_DURATION_MS } from "@/components/overlay/widgetLifecycle";
import { AgentStatusIndicator } from "./AgentStatusIndicator";

/**
 * Settings · Overlay tab.
 *
 * The user shouldn't have to click "Create" to start using the overlay
 * — a brand-new account auto-mints a "Default" token the first time
 * this tab loads, then renders every widget URL inline with a Copy
 * button. Multiple tokens are still supported (handy for "main scene"
 * vs "friend test"), but they're surfaced as a compact list at the
 * bottom rather than gating the URLs behind a form.
 */

type OverlayToken = {
  token: string;
  label: string;
  createdAt: string;
  lastSeenAt?: string | null;
  revokedAt?: string | null;
  enabledWidgets?: string[];
};

type OverlayResp = { items: OverlayToken[] };

interface WidgetMeta {
  id: string;
  label: string;
  hint: string;
}

const WIDGETS: ReadonlyArray<WidgetMeta> = [
  { id: "opponent", label: "Opponent identity", hint: "Pre-game dossier — race, MMR, head-to-head" },
  { id: "match-result", label: "Match result", hint: "Victory / Defeat card after the game" },
  { id: "post-game", label: "Post-game build", hint: "Build summary at end of game" },
  { id: "mmr-delta", label: "MMR delta", hint: "± MMR change from this game" },
  { id: "streak", label: "Streak", hint: "Active 3+ win/loss run" },
  { id: "cheese", label: "Cheese alert", hint: "Triggers on cheese probability ≥ 0.4" },
  { id: "rematch", label: "Rematch", hint: "Flags when you've played this opponent recently" },
  { id: "rival", label: "Rival", hint: "Frequent-opponent context" },
  { id: "rank", label: "Rank", hint: "Player's league / tier / MMR" },
  { id: "meta", label: "Meta snapshot", hint: "Top openings opponents bring in this matchup" },
  { id: "topbuilds", label: "Top builds", hint: "Your best builds vs this matchup" },
  { id: "fav-opening", label: "Favourite opening", hint: "Opponent's most-shown opening" },
  { id: "best-answer", label: "Best answer", hint: "Your best counter vs that opening" },
  { id: "scouting", label: "Scouting tells", hint: "Predicted strategies + tell timings" },
  { id: "session", label: "Session record", hint: "Today's W-L + your current MMR" },
];

export function SettingsOverlay({ origin }: { origin?: string }) {
  const { getToken } = useAuth();
  const { data, isLoading, error, mutate } = useApi<OverlayResp>(
    "/v1/overlay-tokens",
  );
  const { toast } = useToast();

  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<OverlayToken | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [autoMintError, setAutoMintError] = useState<string | null>(null);
  const [testingWidget, setTestingWidget] = useState<string | null>(null);
  const autoMintingRef = useRef(false);
  // Tracks the in-flight Test fire so we can cancel/clean it up if the
  // user navigates away or fires another test before the visibility
  // window expires. The window mirrors `TEST_DURATION_MS` so the
  // button's loading state matches when the OBS widget actually
  // disappears.
  const testTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (testTimerRef.current !== null) {
        window.clearTimeout(testTimerRef.current);
        testTimerRef.current = null;
      }
    };
  }, []);

  const items = useMemo(
    () => (data?.items ?? []).filter((i) => !i.revokedAt),
    [data],
  );
  const activeToken = items[0] ?? null;

  // Auto-mint a default token on first visit so the user can copy URLs
  // immediately without clicking through a form.
  useEffect(() => {
    if (isLoading || error) return;
    if (data && items.length === 0 && !autoMintingRef.current) {
      autoMintingRef.current = true;
      void (async () => {
        try {
          await apiCall(getToken, "/v1/overlay-tokens", {
            method: "POST",
            body: JSON.stringify({ label: "Default" }),
          });
          await mutate();
        } catch (err) {
          const message =
            (err as ClientApiError | undefined)?.message ?? "Please try again.";
          setAutoMintError(message);
        } finally {
          autoMintingRef.current = false;
        }
      })();
    }
  }, [isLoading, error, data, items.length, getToken, mutate]);

  async function mintAdditional() {
    try {
      const label = `Token ${items.length + 1}`;
      await apiCall(getToken, "/v1/overlay-tokens", {
        method: "POST",
        body: JSON.stringify({ label }),
      });
      await mutate();
      toast.success(`Minted "${label}"`);
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't mint token", { description: message });
    }
  }

  async function confirmRevoke() {
    const target = pendingRevoke;
    if (!target || revoking) return;
    setRevoking(true);
    try {
      await apiCall(
        getToken,
        `/v1/overlay-tokens/${encodeURIComponent(target.token)}`,
        { method: "DELETE" },
      );
      await mutate();
      toast.success(`"${target.label}" revoked`);
      setPendingRevoke(null);
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't revoke token", { description: message });
    } finally {
      setRevoking(false);
    }
  }

  async function toggleWidget(token: string, widget: string, on: boolean) {
    if (busyToken) return;
    setBusyToken(token);
    try {
      await apiCall(
        getToken,
        `/v1/overlay-tokens/${encodeURIComponent(token)}/widgets`,
        {
          method: "PATCH",
          body: JSON.stringify({ widget, enabled: on }),
        },
      );
      await mutate();
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't update widget", { description: message });
    } finally {
      setBusyToken(null);
    }
  }

  // Fire a synthetic ``overlay:live`` payload at the active token so
  // the streamer can preview a single widget (or the full layout) in
  // OBS without waiting for a real ladder game. Server-side the
  // endpoint shares the same per-token rate limiter as the agent's
  // live route, so a Test mash can't flood the socket.
  //
  // We hold the button in its "testing" state for the same window the
  // OBS widget itself stays visible (`TEST_DURATION_MS`, ~20 s) and
  // disable every other Test button alongside it. That way the user
  // gets a single coherent fire-and-forget cue: click → button locks
  // → widget appears in OBS → both reset together. Without this the
  // button would snap back as soon as the API responded (~100 ms),
  // leaving the user mashing "Test" while the previous widget was
  // still on screen.
  function clearTestTimer() {
    if (testTimerRef.current !== null) {
      window.clearTimeout(testTimerRef.current);
      testTimerRef.current = null;
    }
  }

  async function testWidget(token: string, widget?: string) {
    // Treat a click while a test is in flight as "cancel + clear" —
    // the streamer can dismiss the test before the natural visibility
    // window expires. Per-widget cancel only fires when the click is
    // on the SAME widget that's currently testing; clicks on other
    // widgets are still gated by the disabled state in the UI.
    if (testingWidget) {
      const key = widget || "all";
      if (testingWidget === key) {
        await cancelTest(token, widget);
      }
      return;
    }
    const key = widget || "all";
    clearTestTimer();
    setTestingWidget(key);
    try {
      await apiCall(getToken, "/v1/overlay-events/test", {
        method: "POST",
        body: JSON.stringify({ token, widget }),
      });
      toast.success(
        widget
          ? `Sent test data to "${widget}"`
          : "Sent test data to every enabled widget",
        {
          description:
            "Renders for ~20 s in OBS, then auto-hides. Click Stop to dismiss early.",
        },
      );
      // Hold the loading state for the same window the overlay
      // widget itself stays visible. When it expires the button
      // resets so the streamer can fire another test.
      testTimerRef.current = window.setTimeout(() => {
        setTestingWidget(null);
        testTimerRef.current = null;
      }, TEST_DURATION_MS);
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't fire test event", { description: message });
      // Reset immediately on failure — the OBS widget never received
      // anything so there's nothing to wait for.
      setTestingWidget(null);
    }
  }

  async function cancelTest(token: string, widget?: string) {
    clearTestTimer();
    setTestingWidget(null);
    try {
      await apiCall(getToken, "/v1/overlay-events/test/cancel", {
        method: "POST",
        body: JSON.stringify({ token, widget }),
      });
    } catch (err) {
      // Cancel is best-effort — the OBS widget will still auto-hide
      // when its natural timer expires. Log the failure so the user
      // knows but don't block them mashing Test again.
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't dismiss the test", { description: message });
    }
  }

  if (isLoading) return <Skeleton rows={3} />;
  if (error) {
    return (
      <Card>
        <p className="px-2 py-3 text-body text-danger">
          Couldn&apos;t load your overlay tokens. {error.message}
        </p>
      </Card>
    );
  }
  if (autoMintError && !activeToken) {
    return (
      <Card>
        <div className="flex items-start gap-2 px-2 py-3 text-body text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
          <div className="space-y-2">
            <p>Couldn&apos;t mint your first overlay token automatically.</p>
            <p className="text-caption text-text-muted">
              {autoMintError}
            </p>
            <Button onClick={() => void mutate()} variant="secondary" size="sm">
              Try again
            </Button>
          </div>
        </div>
      </Card>
    );
  }
  if (!activeToken) {
    // Auto-mint is in flight — render a quiet placeholder so the page
    // doesn't flash a confusing empty state for the half-second the
    // POST takes.
    return <Skeleton rows={3} />;
  }

  return (
    <div className="space-y-6">
      <Section
        title="OBS Browser Source URLs"
        description="Copy the URLs you want into OBS. Each widget is transparent and positioned independently. The URLs share the same socket connection so your overlay stays in sync."
      >
        <Card>
          <div className="flex items-start gap-3 px-2 py-2 text-caption text-text-muted">
            <Tv className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent-cyan" aria-hidden />
            <p>
              The <strong className="text-text">Session record</strong>{" "}
              widget works the moment your overlay connects. Every other
              widget renders the moment a game lands in the cloud — install
              the desktop{" "}
              <a
                href="/devices"
                className="text-accent-cyan underline-offset-2 hover:underline"
              >
                agent
              </a>{" "}
              so your replays auto-upload, then click <em>Test</em> next to
              any widget to preview it in OBS without waiting for a real
              match.
            </p>
          </div>
        </Card>
        <Card padded={false}>
          <ActiveTokenHeader
            token={activeToken}
            origin={origin}
            onTestAll={() => void testWidget(activeToken.token)}
            testing={testingWidget === "all"}
            anyTesting={testingWidget !== null}
          />
          <AllInOneRow token={activeToken} origin={origin} />
          <WidgetList
            token={activeToken}
            origin={origin}
            busy={busyToken === activeToken.token}
            onToggleWidget={(w, on) => toggleWidget(activeToken.token, w, on)}
            onTestWidget={(w) => void testWidget(activeToken.token, w)}
            testingWidget={testingWidget}
          />
        </Card>
        <StuckWidgetHelp />
      </Section>

      <Section
        title="Manage tokens"
        description="Each token is a hidden bearer credential. Revoke a token to invalidate every URL above (handy if a stream key ever leaks)."
      >
        <Card padded={false}>
          <ul className="divide-y divide-border">
            {items.map((t) => (
              <li
                key={t.token}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-body font-medium text-text">
                      {t.label}
                    </span>
                    <Badge variant="cyan" size="sm">
                      {`${t.token.slice(0, 6)}…${t.token.slice(-4)}`}
                    </Badge>
                    {t.token === activeToken.token ? (
                      <Badge variant="success" size="sm">
                        active
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-caption text-text-muted">
                    Created {fmtAgo(t.createdAt)}
                    {t.lastSeenAt
                      ? ` · seen ${fmtAgo(t.lastSeenAt)}`
                      : " · not yet connected"}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPendingRevoke(t)}
                  iconLeft={<Trash2 className="h-4 w-4" aria-hidden />}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
          <div className="border-t border-border px-4 py-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void mintAdditional()}
              iconLeft={<Plus className="h-4 w-4" aria-hidden />}
            >
              Mint another token
            </Button>
          </div>
        </Card>
      </Section>

      <ConfirmDialog
        open={pendingRevoke !== null}
        onClose={() => (revoking ? undefined : setPendingRevoke(null))}
        onConfirm={confirmRevoke}
        title="Revoke overlay token?"
        description={
          pendingRevoke
            ? `OBS sources using "${pendingRevoke.label}" will go blank immediately. This can't be undone — you'll need a new token + URL.`
            : undefined
        }
        confirmLabel="Revoke"
        cancelLabel="Cancel"
        intent="danger"
        loading={revoking}
      />
    </div>
  );
}

function ActiveTokenHeader({
  token,
  origin,
  onTestAll,
  testing,
  anyTesting,
}: {
  token: OverlayToken;
  origin?: string;
  onTestAll: () => void;
  testing: boolean;
  anyTesting: boolean;
}) {
  void origin;
  // Treat "testing this very button" specially so the click reads as
  // a Stop instead of a (no-op) repeat fire. Other widgets still see
  // the dimmed disabled state — there's only ever one in-flight test
  // at a time per token.
  const otherTesting = anyTesting && !testing;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
      <Tv className="h-4 w-4 flex-shrink-0 text-accent-cyan" aria-hidden />
      <span className="text-body font-medium text-text">{token.label}</span>
      <Badge variant="cyan" size="sm">
        {`${token.token.slice(0, 6)}…${token.token.slice(-4)}`}
      </Badge>
      <span className="ml-auto flex items-center gap-3">
        {/*
          Real-time agent indicator. Drives off the same SSE stream
          the dashboard uses, so green/grey here matches what the
          streamer would see from the /app dashboard's LiveGamePanel.
          ``token.lastSeenAt`` continues to surface OBS-side
          connectivity (when did this overlay token's Browser Source
          last open a socket?) — distinct from "is the agent emitting?"
        */}
        <AgentStatusIndicator />
        <span className="text-caption text-text-muted">
          {token.lastSeenAt
            ? `Seen ${fmtAgo(token.lastSeenAt)}`
            : "Not yet connected"}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={onTestAll}
          disabled={otherTesting}
          iconLeft={
            testing ? (
              <Square className="h-4 w-4" aria-hidden />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden />
            )
          }
          title={
            testing
              ? "Click to dismiss the test fire early"
              : "Fire sample data at every enabled widget"
          }
        >
          {testing ? "Stop test" : "Test all"}
        </Button>
      </span>
    </div>
  );
}

function AllInOneRow({
  token,
  origin,
}: {
  token: OverlayToken;
  origin?: string;
}) {
  const url = `${origin ?? ""}/overlay/${token.token}`;
  return (
    <div className="space-y-2 border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-caption font-semibold uppercase tracking-wider text-text-muted">
          All-in-one URL
        </span>
        <span className="text-caption text-text-muted">
          One Browser Source · all enabled widgets composited together
        </span>
      </div>
      <UrlRow url={url} compact={false} />
    </div>
  );
}

function WidgetList({
  token,
  origin,
  busy,
  onToggleWidget,
  onTestWidget,
  testingWidget,
}: {
  token: OverlayToken;
  origin?: string;
  busy: boolean;
  onToggleWidget: (widget: string, enabled: boolean) => void;
  onTestWidget: (widget: string) => void;
  testingWidget: string | null;
}) {
  const enabled = useMemo(
    () => new Set<string>(token.enabledWidgets ?? WIDGETS.map((w) => w.id)),
    [token.enabledWidgets],
  );
  return (
    <div className="space-y-2 px-4 py-3">
      <p className="text-caption text-text-muted">
        Add only the widgets you actually use to OBS, position each
        independently. Click <em>Test</em> to fire sample data at one
        widget so you can see it render and decide where to put it.
      </p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {WIDGETS.map((w) => {
          const url = `${origin ?? ""}/overlay/${token.token}/widget/${w.id}`;
          const isOn = enabled.has(w.id);
          const isTesting = testingWidget === w.id;
          const anyTesting = testingWidget !== null;
          return (
            <li
              key={w.id}
              className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
            >
              <div className="flex items-start gap-3 sm:min-w-[14rem] sm:flex-shrink-0">
                <Toggle
                  checked={isOn}
                  disabled={busy}
                  onChange={(on) => onToggleWidget(w.id, on)}
                  label={`Toggle ${w.label}`}
                />
                <div className="min-w-0">
                  <div className="text-body font-medium text-text">
                    {w.label}
                  </div>
                  <div className="text-caption text-text-dim">{w.hint}</div>
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <UrlRow
                  url={url}
                  compact
                  onTest={() => onTestWidget(w.id)}
                  testing={isTesting}
                  // Other widgets stay locked while a different widget
                  // is testing — only the testing widget's own button
                  // remains clickable, where it acts as Stop.
                  testDisabled={(anyTesting && !isTesting) || !isOn}
                  testTitle={
                    isTesting
                      ? "Click to dismiss the test fire early"
                      : isOn
                        ? "Fire sample data at this widget"
                        : "Enable this widget first to test it"
                  }
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function UrlRow({
  url,
  compact,
  onTest,
  testing,
  testDisabled,
  testTitle,
}: {
  url: string;
  compact: boolean;
  onTest?: () => void;
  testing?: boolean;
  testDisabled?: boolean;
  testTitle?: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      <code
        className={[
          "min-w-0 flex-1 break-all rounded bg-bg-elevated p-2 font-mono",
          compact ? "text-[11px]" : "text-caption",
        ].join(" ")}
      >
        {url}
      </code>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void onCopy()}
        iconLeft={
          copied ? (
            <Check className="h-4 w-4" aria-hidden />
          ) : (
            <Copy className="h-4 w-4" aria-hidden />
          )
        }
      >
        {copied ? "Copied" : "Copy"}
      </Button>
      {onTest ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={onTest}
          // No loading spinner once testing starts — the Stop label
          // already conveys "in flight". The button stays enabled
          // so a second click triggers the cancel path.
          disabled={testDisabled}
          title={testTitle}
          iconLeft={
            testing ? (
              <Square className="h-4 w-4" aria-hidden />
            ) : (
              <Play className="h-4 w-4" aria-hidden />
            )
          }
        >
          {testing ? "Stop" : "Test"}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Help block explaining how to clear a stuck widget in OBS / Streamlabs.
 *
 * Stale widgets are normally cleared after ~6 minutes of no new game,
 * but if the streamer wants the panel gone NOW (e.g. the dossier is
 * sitting on the previous opponent and they're about to queue), the
 * Browser Source's cache holds the page state across show/hide. The
 * vendor-specific "Refresh cache" action forces OBS to redraw the page
 * and our overlay re-mounts in a clean state.
 */
function StuckWidgetHelp() {
  return (
    <Card>
      <div className="flex items-start gap-3 px-2 py-2 text-caption text-text-muted">
        <RefreshCw
          className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent-cyan"
          aria-hidden
        />
        <div className="space-y-2">
          <p className="text-text">Widget stuck on the last opponent?</p>
          <p>
            Most widgets auto-hide on a per-panel timer (Match result and
            Streak in seconds, Scouting after about 22 s, Opponent identity
            after a longer idle gap). The persistent panels &mdash;{" "}
            <strong className="text-text">Session record</strong> and{" "}
            <strong className="text-text">Top builds</strong> &mdash; stay
            on screen by design. If a widget&apos;s sitting stale, force the
            Browser Source to redraw:
          </p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              <strong className="text-text">OBS Studio:</strong> right-click the
              Browser Source for the widget &rarr; <em>Refresh cache of current
              page</em>.
            </li>
            <li>
              <strong className="text-text">Streamlabs Desktop:</strong> click
              the Browser Source&apos;s gear icon (or right-click) &rarr;{" "}
              <em>Refresh cache</em>. The widget reloads with no stored state.
            </li>
            <li>
              <strong className="text-text">Streamlabs OBS / OBS.live:</strong>{" "}
              same as Streamlabs Desktop &mdash; the option lives on the source
              context menu.
            </li>
          </ul>
          <p>
            <strong className="text-text">Tip:</strong> in OBS Studio you can
            also tick <em>Shutdown source when not visible</em> and{" "}
            <em>Refresh browser when scene becomes active</em> on the Browser
            Source so the widget always re-mounts when you switch scenes.
          </p>
          <p>
            <strong className="text-text">Test fires</strong> always carry a
            short timer (about 20 s), so previewing the Session or Top builds
            panels with the Test button never leaves sample data on your scene.
          </p>
        </div>
      </div>
    </Card>
  );
}
