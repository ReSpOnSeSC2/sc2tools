"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import {
  Tv,
  AlertTriangle,
  BookOpen,
  ArrowUpRight,
} from "lucide-react";
import { apiCall, boundedApiRequest, useApi, type ClientApiError } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { WidgetList } from "./OverlayWidgetGrid";
import { useToast } from "@/components/ui/Toast";
import { useOverlayTests, OverlayLiveTestDialog } from "./OverlayTestControls";
import { OverlayProfileEditor } from "./OverlayProfileEditor";
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
import { OverlayHealthProvider } from "@/components/overlay/OverlayHealthContext";
import { OverlayTokenManager } from "./OverlayTokenManager";
import { OverlayHealthBoard } from "./OverlayHealthBoard";

/**
 * Settings · Overlay tab.
 *
 * The user shouldn't have to click "Create" to start using the overlay
 * — a brand-new account auto-mints a "Default" token the first time
 * this tab loads, then renders every widget URL inline with a Copy
 * button. An owner-scoped selector drives every displayed source URL;
 * Tokens provides rename, resumable rotation and separate danger revocation.
 */

type OverlayResp = { items: OverlayToken[] };

export function SettingsOverlay({ origin }: { origin?: string }) {
  const { userId, isLoaded, isSignedIn } = useAuth();
  if (!isLoaded || !isSignedIn || !userId) return <Skeleton rows={3} />;
  return <SettingsOverlayOwner key={userId} origin={origin} />;
}

function SettingsOverlayOwner({ origin }: { origin?: string }) {
  const { getToken: readToken, userId, isLoaded, isSignedIn } = useAuth();
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const getToken = useCallback(async () => {
    if (!live.current) throw new Error("Account changed");
    const token = await readToken();
    if (!live.current) throw new Error("Account changed");
    return token;
  }, [readToken]);
  const section = useOverlaySection();
  const { data, isLoading, error, mutate } = useApi<OverlayResp>(
    "/v1/overlay-tokens", { keepPreviousData: false }, { timeoutMs: 15_000 },
  );
  const { toast } = useToast();

  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ owner: string; token: string } | null>(null);
  const [autoMintError, setAutoMintError] = useState<string | null>(null);
  const { testingWidget, pendingLiveTest, setPendingLiveTest, testWidget } = useOverlayTests(getToken, toast);
  const autoMintingRef = useRef(false);

  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const items = useMemo(
    () => owner ? (data?.items ?? []).filter((i) => !i.revokedAt || i.rotationPending) : [],
    [data, owner],
  );
  const activeToken = items.find(item => selection?.owner === owner && item.token === selection.token) ?? items[0] ?? null;
  const selectToken = (token: string) => { if (owner) setSelection({ owner, token }); };

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
    if (!owner || isLoading || error || data?.items.some(item => item.rotationPending)) return;
    if (data && items.length === 0 && !autoMintingRef.current) {
      autoMintingRef.current = true;
      void (async () => {
        try {
          await boundedApiRequest(signal => apiCall(getToken, "/v1/overlay-tokens", {
            method: "POST",
            body: JSON.stringify({ label: "Default" }), signal,
          }), 15_000);
          if (live.current) await mutate();
        } catch (err) {
          const message =
            (err as ClientApiError | undefined)?.message ?? "Please try again.";
          if (live.current) setAutoMintError(message);
        } finally {
          autoMintingRef.current = false;
        }
      })();
    }
  }, [owner, isLoading, error, data, items.length, getToken, mutate]);

  async function toggleWidget(token: string, widget: string, on: boolean) {
    if (!live.current || busyToken) return;
    setBusyToken(token);
    try {
      await boundedApiRequest(signal => apiCall(
        getToken,
        `/v1/overlay-tokens/${encodeURIComponent(token)}/widgets`,
        {
          method: "PATCH",
          body: JSON.stringify({ widget, enabled: on }), signal,
        },
      ), 15_000);
      if (live.current) await mutate();
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      if (live.current) toast.error("Couldn't update widget", { description: message });
    } finally {
      if (live.current) setBusyToken(null);
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
  if (isLoading || !isLoaded || !isSignedIn || !userId) return <Skeleton rows={3} />;
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

  if (activeToken.rotationPending) return <OverlayTokenManager key={owner} items={items} selected={activeToken} onSelect={selectToken} onRefresh={() => mutate()} />;

  return (
    <OverlayProfileEditor key={`${userId}:${activeToken.token}`} token={activeToken} onSaved={saved => { void mutate(previous => previous ? { items: previous.items.map(item => item.token === activeToken.token ? { ...item, ...saved } : item) } : previous, { revalidate: false }); }}>{({ profile, saving: profileSaving, setTheme, setDuration }) => <OverlayHealthProvider token={activeToken.token} enabledWidgets={activeToken.enabledWidgets} enabled={section === "setup" || section === "widgets"}><div className="space-y-6">
      <OverlayTokenManager key={owner} items={items} selected={activeToken} onSelect={selectToken} onRefresh={() => mutate()} compact={section !== "tokens"} />
      <OverlayManagerNav section={section} />
      <div hidden={section !== "setup" && section !== "widgets"}><OverlayHealthBoard /></div>
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
          <AllInOneRow token={activeToken} origin={origin} theme={profile.theme} />
          <div hidden={section !== "widgets"}><WidgetList
            key={`${userId}:${activeToken.token}`}
            token={activeToken}
            origin={origin}
            theme={profile.theme}
            profile={profile}
            profileSaving={profileSaving}
            onDurationChange={setDuration}
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
        theme={profile.theme}
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

      <fieldset className="min-w-0 max-w-full" disabled={profileSaving}><OverlayThemeSection theme={profile.theme} onChange={setTheme} /></fieldset>
      </div>

      <OverlayLiveTestDialog pending={pendingLiveTest} busy={testingWidget !== null} origin={origin}
        onClose={() => setPendingLiveTest(null)} onSend={() => { if (pendingLiveTest) void testWidget(pendingLiveTest.token, pendingLiveTest.widget, true); }} />
    </div></OverlayHealthProvider>}</OverlayProfileEditor>
  );
}
