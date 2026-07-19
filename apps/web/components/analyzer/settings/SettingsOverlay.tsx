"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  Plus,
  Trash2,
  Tv,
  Check,
  AlertTriangle,
  Square,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import { io } from "socket.io-client";
import { apiCall, useApi, API_BASE, type ClientApiError } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { fmtAgo } from "@/lib/format";
import { clientTimezone } from "@/lib/timeseries";
import { TEST_DURATION_MS } from "@/components/overlay/widgetLifecycle";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import {
  appendOverlayThemeToUrl,
  normalizeOverlayTheme,
  type OverlayTheme,
} from "@/lib/overlayTheme";
import {
  appendGhostToUrl,
  assignSavedGhostBuild,
  clearGhostTarget,
  emptyGhostBuildConfig,
  GHOST_BUILD_LIBRARY_STORAGE_KEY,
  GHOST_BUILD_STORAGE_KEY,
  migrateLegacyGhostTargetInStorage,
  readArmedGhostConfig,
  readArmedGhostTarget,
  readSavedGhostBuilds,
  writeArmedGhostConfig,
  type GhostBuildConfig,
  type GhostMatchupKey,
  type SavedGhostBuild,
  type GhostTarget,
} from "@/lib/ghostBuild";
import { AgentStatusIndicator } from "./AgentStatusIndicator";
import { SettingsMultiChat } from "./SettingsMultiChat";
import { UrlRow } from "./OverlayUrlRow";
import { GhostLegacyMigration } from "./GhostLegacyMigration";
import { GhostMatchupManager } from "./GhostMatchupManager";
import { OverlayThemeSection } from "./OverlayThemeSection";

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
  /**
   * The widget is armed by its own URL param instead of the server's
   * enabledWidgets list (which predates it — the toggle endpoint would
   * 400 on the unknown id). The row renders an "always on" badge in
   * place of the server toggle; Test still works.
   */
  urlArmed?: boolean;
  /**
   * The widget is fully self-driven (opens its own data connections)
   * — a synthetic game payload can't exercise it, so the row hides
   * the Test button. Live status is visible in the widget itself.
   */
  noTest?: boolean;
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
  { id: "randomizer", label: "Build randomizer", hint: "Spins a weighted random build for each new matchup" },
  {
    id: "ghost-build",
    label: "Ghost Build coach",
    hint: "Tonight's homework — the armed build's next steps synced to the live game, with a drift chip",
    urlArmed: true,
  },
  {
    id: "multichat",
    label: "Multi-platform chat",
    hint: "Twitch + Kick + YouTube + TikTok chat in one feed — set your channels and styling in the Multi-platform chat section below. Test plays a demo chat stream.",
  },
  {
    id: "chat-highlight",
    label: "Chat highlight",
    hint: "Pins a chat message on stream — pick the message from the Stream Dock. Test shows a sample highlight.",
  },
  {
    id: "chat-poll",
    label: "Chat poll",
    hint: "Live viewer poll with !1 / !2 chat voting — start and close polls from the Stream Dock. Test runs a sample poll.",
  },
  {
    id: "chat-alerts",
    label: "Event alerts",
    hint: "Subs, raids, gifts and superchats as an alert toaster — feed and moderation run through the Stream Dock. Test plays sample alerts.",
  },
  {
    id: "stream-goals",
    label: "Stream goals",
    hint: "Animated goal progress bars — set and update goals from the Stream Dock. Test shows sample goals.",
  },
  {
    id: "session-recap",
    label: "Session recap card",
    hint: "A W-L + net-MMR recap card you fire on demand from the Stream Dock. Test fires a sample recap.",
  },
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

  // Overlay theme — persisted client-side per token (the theme itself
  // travels in the copyable URLs as ?theme=…, so there's no server
  // state to sync; localStorage just keeps the pickers stable across
  // visits). Stored values are untrusted like any ?theme= string:
  // everything funnels through normalizeOverlayTheme.
  const [storedTheme, setStoredTheme] = useLocalStorageState<OverlayTheme>(
    `sc2tools:overlay-theme:${activeToken?.token ?? "default"}`,
    {},
    (raw): raw is OverlayTheme =>
      typeof raw === "object" && raw !== null && !Array.isArray(raw),
  );
  const theme = useMemo(
    () => normalizeOverlayTheme(storedTheme),
    [storedTheme],
  );
  const setTheme = (next: OverlayTheme) =>
    setStoredTheme(normalizeOverlayTheme(next));

  // Ghost's nine exact-matchup slots travel in the dedicated widget URL;
  // the larger saved-build library stays local and only powers the picker.
  const [ghostConfig, setGhostConfig] = useState<GhostBuildConfig>(() =>
    emptyGhostBuildConfig(),
  );
  const [ghostLibrary, setGhostLibrary] = useState<SavedGhostBuild[]>([]);
  const [legacyGhostTarget, setLegacyGhostTarget] =
    useState<GhostTarget | null>(null);
  useEffect(() => {
    const refreshGhost = () => {
      setGhostConfig(readArmedGhostConfig() ?? emptyGhostBuildConfig());
      setGhostLibrary(readSavedGhostBuilds());
      setLegacyGhostTarget(readArmedGhostTarget());
    };
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === GHOST_BUILD_STORAGE_KEY
        || event.key === GHOST_BUILD_LIBRARY_STORAGE_KEY
        || event.key === null
      ) {
        refreshGhost();
      }
    };
    refreshGhost();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function migrateLegacyGhostBuild(matchup: GhostMatchupKey) {
    if (!legacyGhostTarget) return;
    if (!migrateLegacyGhostTargetInStorage(legacyGhostTarget, matchup)) {
      toast.error("Couldn't upgrade the previous Ghost build", {
        description:
          "Browser storage is unavailable or changed in another tab. Your previous build was left untouched.",
      });
      return;
    }

    const nextConfig = readArmedGhostConfig();
    if (!nextConfig) {
      toast.error("Couldn't verify the Ghost upgrade", {
        description:
          "Your browser did not return the saved matchup. Reload Settings before trying again.",
      });
      return;
    }
    setGhostConfig(nextConfig);
    setGhostLibrary(readSavedGhostBuilds());
    setLegacyGhostTarget(null);
    toast.success(`Previous build upgraded to ${matchup}`, {
      description:
        "It is now saved in your library and assigned only to that matchup. Copy the updated Ghost Build widget URL before going live.",
    });
  }

  function assignGhostBuild(
    matchup: GhostMatchupKey,
    build: SavedGhostBuild,
  ) {
    const next = assignSavedGhostBuild(ghostConfig, matchup, build);
    if (!writeArmedGhostConfig(next)) {
      toast.error("Couldn't save Ghost matchup", {
        description: "Browser storage is unavailable or full. Your existing assignments were left unchanged.",
      });
      return;
    }
    setGhostConfig(next);
    toast.success(`${matchup} coach updated`, {
      description: `Ghost will use “${build.target.name}” when you play ${matchup}. Copy the widget URL again before going live.`,
    });
  }

  function clearGhostBuild(matchup: GhostMatchupKey) {
    const next = clearGhostTarget(ghostConfig, matchup);
    if (!writeArmedGhostConfig(next)) {
      toast.error("Couldn't clear Ghost matchup", {
        description: "Browser storage is unavailable. Please try again.",
      });
      return;
    }
    setGhostConfig(next);
    toast.success(`${matchup} coach cleared`, {
      description: "The saved build remains in your library and can be selected again later.",
    });
  }

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
          <AllInOneRow token={activeToken} origin={origin} theme={theme} />
          <WidgetList
            token={activeToken}
            origin={origin}
            theme={theme}
            ghostConfig={ghostConfig}
            busy={busyToken === activeToken.token}
            onToggleWidget={(w, on) => toggleWidget(activeToken.token, w, on)}
            onTestWidget={(w) => void testWidget(activeToken.token, w)}
            testingWidget={testingWidget}
          />
        </Card>
        <ConnectionCheck token={activeToken.token} lastSeenAt={activeToken.lastSeenAt} />
        <StuckWidgetHelp />
      </Section>

      <SettingsMultiChat token={activeToken.token} />

      <Section
        title="Ghost Build coach"
        description="Choose the timed build Ghost should coach for each of the nine concrete race matchups. Assignments stay on this device and are embedded into the dedicated OBS URL."
      >
        <Card>
          <div className="min-w-0 max-w-full space-y-5">
            {legacyGhostTarget ? (
              <GhostLegacyMigration
                target={legacyGhostTarget}
                onMigrate={migrateLegacyGhostBuild}
              />
            ) : null}
            <GhostMatchupManager
              loadout={ghostConfig}
              library={ghostLibrary}
              onAssign={assignGhostBuild}
              onClear={clearGhostBuild}
              disabled={legacyGhostTarget !== null}
            />
          </div>
        </Card>
      </Section>

      <OverlayThemeSection theme={theme} onChange={setTheme} />

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
  theme,
}: {
  token: OverlayToken;
  origin?: string;
  theme: OverlayTheme;
}) {
  // Non-default themes ride along in the URL itself so the OBS Browser
  // Source needs no re-auth — default themes leave the URL untouched.
  const url = appendOverlayThemeToUrl(
    `${origin ?? ""}/overlay/${token.token}`,
    theme,
  );
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
  theme,
  ghostConfig,
  busy,
  onToggleWidget,
  onTestWidget,
  testingWidget,
}: {
  token: OverlayToken;
  origin?: string;
  theme: OverlayTheme;
  /** Exact-matchup Ghost loadout baked into the ghost-build widget URL. */
  ghostConfig: GhostBuildConfig;
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
    <div className="min-w-0 space-y-2 px-4 py-3">
      <p className="text-caption text-text-muted">
        Add only the widgets you actually use to OBS, position each
        independently. Click <em>Test</em> to fire sample data at one
        widget so you can see it render and decide where to put it.
      </p>
      <ul className="min-w-0 divide-y divide-border rounded-lg border border-border">
        {WIDGETS.map((w) => {
          const themedUrl = appendOverlayThemeToUrl(
            `${origin ?? ""}/overlay/${token.token}/widget/${w.id}`,
            theme,
          );
          // The Ghost Build widget carries its v2 loadout in a client-only
          // #ghost= fragment after the optional ?theme= query. Copy after
          // arming; the loadout never needs a server round-trip.
          const url =
            w.id === "ghost-build"
              ? appendGhostToUrl(themedUrl, ghostConfig)
              : themedUrl;
          // URL-armed widgets have no server toggle — the Ghost URL value is
          // the opt-in, so the row treats them as always on.
          const isOn = w.urlArmed ? true : enabled.has(w.id);
          const isTesting = testingWidget === w.id;
          const anyTesting = testingWidget !== null;
          const hint =
            w.id === "ghost-build"
              ? Object.keys(ghostConfig.slots).length > 0
                ? `Dedicated Browser Source · ${Object.keys(ghostConfig.slots).length}/9 matchups ready — copy the URL again after changing an assignment`
                : "Dedicated Browser Source (not part of All-in-one) — save a build from a completed game, assign it below, then copy this URL"
              : w.hint;
          return (
            <li
              key={w.id}
              className="grid min-w-0 grid-cols-1 gap-2 px-3 py-2 sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-center sm:gap-3"
            >
              <div className="flex min-w-0 items-start gap-3">
                {w.urlArmed ? (
                  <Badge variant="cyan" size="sm">
                    URL
                  </Badge>
                ) : (
                  <Toggle
                    checked={isOn}
                    disabled={busy}
                    onChange={(on) => onToggleWidget(w.id, on)}
                    label={`Toggle ${w.label}`}
                  />
                )}
                <div className="min-w-0">
                  <div className="text-body font-medium text-text">
                    {w.label}
                  </div>
                  <div className="break-words text-caption text-text-dim">{hint}</div>
                </div>
              </div>
              <div className="min-w-0 flex-1">
                {w.noTest ? (
                  <UrlRow url={url} compact />
                ) : (
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
                )}
              </div>
            </li>
          );
        })}
      </ul>
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
type ProbeResult = {
  connected: boolean;
  config: boolean;
  session: boolean;
  rttMs: number | null;
  error: string | null;
};

const PROBE_TIMEOUT_MS = 8_000;
const PROBE_SETTLE_MS = 2_500;

/**
 * Pre-stream connection diagnostic. Opens a short-lived overlay socket
 * with the SAME token + auth shape an OBS Browser Source uses and
 * reports what arrived: connect ✓, the connect-replay's
 * ``overlay:config`` and ``overlay:session`` snapshots ✓, and the
 * heartbeat round-trip time. Zero new server surface — these are
 * exactly the events the cloud already emits to every fresh overlay
 * connection, so a green checklist here means a Browser Source with
 * this token will paint.
 */
function ConnectionCheck({
  token,
  lastSeenAt,
}: {
  token: string;
  lastSeenAt?: string | null;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);

  async function run() {
    if (running) return;
    setRunning(true);
    const outcome: ProbeResult = {
      connected: false,
      config: false,
      session: false,
      rttMs: null,
      error: null,
    };
    setResult(null);
    await new Promise<void>((resolve) => {
      const socket = io(API_BASE, {
        auth: { overlayToken: token, timezone: clientTimezone() },
        transports: ["websocket", "polling"],
        reconnection: false,
      });
      let heartbeatSentAt = 0;
      const finish = () => {
        window.clearTimeout(deadline);
        try {
          socket.disconnect();
        } catch {
          /* already closed */
        }
        resolve();
      };
      const deadline = window.setTimeout(() => {
        if (!outcome.connected) {
          outcome.error =
            "Couldn't connect — the token may be revoked or the API unreachable.";
        }
        finish();
      }, PROBE_TIMEOUT_MS);
      socket.on("connect", () => {
        outcome.connected = true;
        heartbeatSentAt = performance.now();
        socket.emit("overlay:heartbeat");
        // Give the connect-replay a beat to deliver config + session,
        // then wrap up.
        window.setTimeout(finish, PROBE_SETTLE_MS);
      });
      socket.on("connect_error", (err: Error) => {
        outcome.error = err?.message || "Connection refused.";
        finish();
      });
      socket.on("overlay:config", () => {
        outcome.config = true;
      });
      socket.on("overlay:session", () => {
        outcome.session = true;
      });
      socket.on("overlay:heartbeat", () => {
        if (heartbeatSentAt && outcome.rttMs == null) {
          outcome.rttMs = Math.max(
            1,
            Math.round(performance.now() - heartbeatSentAt),
          );
        }
      });
    });
    setResult(outcome);
    setRunning(false);
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 px-2 py-2">
        <div className="min-w-0">
          <p className="text-body font-medium text-text">
            Overlay connection check
          </p>
          <p className="text-caption text-text-muted">
            Verifies this token connects and receives data — run it before
            going live.{" "}
            {lastSeenAt
              ? `An overlay last connected ${fmtAgo(lastSeenAt)}.`
              : "No overlay has connected with this token yet."}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void run()}
          disabled={running}
          loading={running}
          iconLeft={<Sparkles className="h-4 w-4" aria-hidden />}
        >
          Check connection
        </Button>
      </div>
      {result ? (
        <div className="space-y-1 border-t border-border px-2 pb-1 pt-3">
          <ProbeRow ok={result.connected} label="Socket connected with this token" />
          <ProbeRow
            ok={result.config}
            label="Widget configuration received (overlay:config)"
          />
          <ProbeRow
            ok={result.session}
            label="Session snapshot received (overlay:session)"
          />
          <ProbeRow
            ok={result.rttMs != null}
            label={
              result.rttMs != null
                ? `Heartbeat round-trip: ${result.rttMs} ms`
                : "Heartbeat round-trip"
            }
          />
          {result.error ? (
            <p className="pt-1 text-caption text-danger" role="alert">
              {result.error}
            </p>
          ) : result.connected && result.config && result.session ? (
            <p className="pt-1 text-caption text-success">
              All clear — Browser Sources with this token will paint.
            </p>
          ) : (
            <p className="pt-1 text-caption text-warning">
              Partially healthy — try again; if a row stays red, re-copy the
              URL or mint a fresh token.
            </p>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function ProbeRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <p className="flex items-center gap-2 text-caption">
      {ok ? (
        <Check className="h-3.5 w-3.5 flex-shrink-0 text-success" aria-hidden />
      ) : (
        <AlertTriangle
          className="h-3.5 w-3.5 flex-shrink-0 text-danger"
          aria-hidden
        />
      )}
      <span className={ok ? "text-text" : "text-text-muted"}>{label}</span>
    </p>
  );
}

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
