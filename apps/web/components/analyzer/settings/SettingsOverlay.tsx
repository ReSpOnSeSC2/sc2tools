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
import { WidgetList } from "./OverlayWidgetGrid";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { fmtAgo } from "@/lib/format";
import { useOverlayTests, OverlayLiveTestDialog } from "./OverlayTestControls";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import {
  normalizeOverlayTheme,
  type OverlayTheme,
} from "@/lib/overlayTheme";
import {
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
import { GhostLegacyMigration } from "./GhostLegacyMigration";
import { GhostMatchupManager } from "./GhostMatchupManager";
import { OverlayThemeSection } from "./OverlayThemeSection";
import { OverlayScenesSection } from "./OverlayScenesSection";
import { OverlayAgentUpsell } from "@/components/instant/AgentLiveUpsell";
import { ConnectionCheck, StuckWidgetHelp } from "./OverlayConnectionCheck";
import { ActiveTokenHeader, AllInOneRow, type OverlayToken } from "./OverlayTokenHeader";
import { OverlayManagerNav, useOverlaySection } from "./OverlayManagerNav";
import { OverlayStarterPacks } from "./OverlayStarterPacks";
import { OverlayDockSetup, OverlayBotSettings } from "./OverlayDockSetup";

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

export function SettingsOverlay({ origin }: { origin?: string }) {
  const { getToken, userId } = useAuth();
  const section = useOverlaySection();
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
      <OverlayManagerNav section={section} />
      <div hidden={section !== "setup"} className="space-y-6">
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
      </div>
      <div hidden={section !== "setup" && section !== "widgets"} className="space-y-6">
      <div hidden={section !== "widgets"}><OverlayStarterPacks key={`${userId}:${activeToken.token}`} token={activeToken} onUpdated={() => mutate()} /></div>
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
          <div hidden={section !== "widgets"}><WidgetList
            key={`${userId}:${activeToken.token}`}
            token={activeToken}
            origin={origin}
            theme={theme}
            ghostConfig={ghostConfig}
            busy={busyToken === activeToken.token}
            onToggleWidget={(w, on) => toggleWidget(activeToken.token, w, on)}
            onTestWidget={(w) => void testWidget(activeToken.token, w)}
            testingWidget={testingWidget}
          /></div>
        </Card>
        <div hidden={section !== "setup"}><ConnectionCheck token={activeToken.token} lastSeenAt={activeToken.lastSeenAt} /><StuckWidgetHelp /></div>
      </Section>
      </div>
      <div hidden={section !== "setup"}><OverlayDockSetup token={activeToken.token} origin={origin} /></div>

      <div hidden={section !== "scenes"}>
      <OverlayScenesSection
        token={activeToken.token}
        origin={origin}
        theme={theme}
      />
      </div>

      <div hidden={section !== "chat"}><SettingsMultiChat token={activeToken.token} /></div>
      <div hidden={section !== "dock"} className="space-y-6"><Card title="Stream Dock"><p className="text-caption text-text-muted">Copy the private Dock URL and add an OBS Custom Browser Dock from <Link href="/settings?tab=overlay&section=setup" className="text-accent underline">Setup</Link>. Use the controls there to manage chat, polls, goals and scenes.</p></Card><OverlayBotSettings /></div>

      <div hidden={section !== "look"} className="space-y-6">
      <SettingsBuildProfile key={activeToken.token} token={activeToken.token} />
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
      </div>

      <div hidden={section !== "tokens"}>
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
      </div>

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

