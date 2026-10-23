"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import {
  Plus,
  Trash2,
  Tv,
  AlertTriangle,
  BookOpen,
  ArrowUpRight,
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
import { useOverlayTests, OverlayLiveTestDialog } from "./OverlayTestControls";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import {
  appendOverlayThemeToUrl,
  normalizeOverlayTheme,
  type OverlayTheme,
} from "@/lib/overlayTheme";
import {
  appendGhostVoiceToUrl,
  GHOST_VOICE_STORAGE_KEY,
} from "@/lib/ghostVoice";
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
import { SettingsMultiChat } from "./SettingsMultiChat";
import { SettingsBuildProfile } from "./SettingsBuildProfile";
import { UrlRow } from "./OverlayUrlRow";
import { GhostLegacyMigration } from "./GhostLegacyMigration";
import { GhostMatchupManager } from "./GhostMatchupManager";
import { OverlayThemeSection } from "./OverlayThemeSection";
import { OverlayScenesSection } from "./OverlayScenesSection";
import { OverlayAgentUpsell } from "@/components/instant/AgentLiveUpsell";
import { ConnectionCheck, StuckWidgetHelp } from "./OverlayConnectionCheck";
import { ActiveTokenHeader, AllInOneRow, type OverlayToken } from "./OverlayTokenHeader";

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
  { id: "cheese", label: "Cheese alert", hint: "When 40%+ of their recent games vs you opened with cheese" },
  { id: "rematch", label: "Rematch", hint: "Flags when you've played this opponent recently" },
  { id: "rival", label: "Rival", hint: "Frequent-opponent context" },
  { id: "rank", label: "Rank", hint: "Player's league / tier / MMR" },
  { id: "meta", label: "Meta snapshot", hint: "Top openings opponents bring in this matchup" },
  { id: "topbuilds", label: "Top builds", hint: "Your best builds vs this matchup" },
  { id: "fav-opening", label: "Favourite opening", hint: "Their most-used opening vs you in this matchup" },
  { id: "best-answer", label: "Best answer", hint: "Your best counter vs that opening" },
  { id: "scouting", label: "Scouting tells", hint: "Game-start briefing: record, last games, best answer, cheese" },
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
    id: "build-profile",
    label: "Build profile",
    hint: "Five-point build ratings, edited and shown/hidden from the Stream Dock or Build profile section below. Enable here, then add its dedicated Browser Source at 720 × 900.",
    noTest: true,
  },
  {
    id: "session-recap",
    label: "Session recap card",
    hint: "A W-L + net-MMR recap card you fire on demand from the Stream Dock. Test fires a sample recap.",
  },
  {
    id: "countdown-timer",
    label: "Countdown timer",
    hint: "A standalone on-stream countdown you set from the Stream Dock (label + minutes) — pulses TIME! at zero until cleared. Test shows a demo timer.",
  },
  {
    id: "stats-ticker",
    label: "Stats ticker",
    hint: "Always-on scrolling bottom line: session record, latest result, rank, goals, live prediction call, top supporters. Test shows a demo strip.",
  },
  {
    id: "lower-third",
    label: "Broadcast lower third",
    hint: "Esports-caster bar after each game: result, MMR delta, opponent head-to-head, session record. Test fires a sample game.",
  },
  {
    id: "chat-oracle",
    label: "Crystal Ball predictions",
    hint: "Chat calls !win / !loss before each game; the verified result scores oracle points and shows a reveal + leaderboard. Test plays a demo round.",
  },
  {
    id: "supporter-wall",
    label: "Supporter wall",
    hint: "Cross-platform loyalty XP: top supporters with Protoss ranks (Probe → Mothership) and level-up toasts. Test shows sample supporters.",
  },
  {
    id: "clip-flag",
    label: "Clip-moment flag",
    hint: "A small CLIP THAT! pulse when chat spikes or a big game moment lands — the full log lives in the Stream Dock. Test shows the pulse.",
  },
  {
    id: "stream-scene",
    label: "BRB / Starting Soon scene",
    hint: "Full-screen scene with countdown — switch between Live, BRB, and Starting Soon from the Stream Dock. Test shows a Starting Soon demo.",
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
  const { testingWidget, pendingLiveTest, setPendingLiveTest, testWidget } = useOverlayTests(getToken, toast);
  const autoMintingRef = useRef(false);

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
      {/* Browser-import users without a paired agent: the overlay's live data needs it. */}
      <OverlayAgentUpsell />
      <Card>
        <div className="flex items-start gap-3">
          <BookOpen className="mt-0.5 h-5 w-5 shrink-0 text-accent-cyan" aria-hidden />
          <div className="min-w-0">
            <h2 className="text-body-lg font-semibold text-text">Build your first stream setup</h2>
            <p className="mt-1 text-body text-text-muted">
              Follow the crash course from your first Browser Source to a complete scene.
              Explore what each widget shows, when it appears, and how to set it up.
            </p>
            <Link
              href="/stream-studio/learn"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-sm text-body font-semibold text-accent-cyan underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Open the Stream Studio crash course
              <span className="sr-only">(opens in a new tab)</span>
              <ArrowUpRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      </Card>
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

      <OverlayScenesSection
        token={activeToken.token}
        origin={origin}
        theme={theme}
      />

      <SettingsBuildProfile key={activeToken.token} token={activeToken.token} />

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

      <OverlayLiveTestDialog pending={pendingLiveTest} busy={testingWidget !== null} origin={origin}
        onClose={() => setPendingLiveTest(null)} onSend={() => { if (pendingLiveTest) void testWidget(pendingLiveTest.token, pendingLiveTest.widget, true); }} />
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
  // Ghost voice coach opt-in: bakes ?voice=1 into the copied Ghost
  // URL. Client-only preference (the loadout itself is URL-armed too)
  // — persisted locally so the choice survives revisits.
  const [ghostVoice, setGhostVoice] = useState(false);
  useEffect(() => {
    try {
      setGhostVoice(localStorage.getItem(GHOST_VOICE_STORAGE_KEY) === "1");
    } catch {
      /* private mode — default off */
    }
  }, []);
  const toggleGhostVoice = (on: boolean) => {
    setGhostVoice(on);
    try {
      localStorage.setItem(GHOST_VOICE_STORAGE_KEY, on ? "1" : "0");
    } catch {
      /* non-persistent is fine */
    }
  };
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
              ? appendGhostToUrl(
                  appendGhostVoiceToUrl(themedUrl, ghostVoice),
                  ghostConfig,
                )
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
                  <Link
                    href={`/stream-studio/learn?widget=${encodeURIComponent(w.id)}#widget-library`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${w.label}: how it works (opens in a new tab)`}
                    className="mt-1 inline-flex min-h-11 items-center gap-1 rounded-sm text-caption font-medium text-accent-cyan underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    How it works
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                </div>
              </div>
              <div className="min-w-0 flex-1">
                {w.id === "ghost-build" ? (
                  <label className="mb-1.5 flex items-center gap-2 text-caption text-text-dim">
                    <Toggle
                      checked={ghostVoice}
                      onChange={toggleGhostVoice}
                      label="Voice coach"
                    />
                    Voice coach — speaks each step ~5 s before its target
                    time (re-copy the URL after toggling)
                  </label>
                ) : null}
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
