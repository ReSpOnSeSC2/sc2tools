"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Tv,
  ArrowUpRight,
} from "lucide-react";
import { apiCall, boundedApiRequest, type ClientApiError } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { WidgetList } from "./OverlayWidgetGrid";
import { useToast } from "@/components/ui/Toast";
import { useOverlayTests, OverlayLiveTestDialog } from "./OverlayTestControls";
import { OverlayProfileEditor } from "./OverlayProfileEditor";
import { useGhostPractice } from "@/lib/useGhostPractice";
import { GhostPracticeSettings } from "./GhostPracticeSettings";
import { SettingsBuildProfile } from "./SettingsBuildProfile";
import { OverlayThemeSection } from "./OverlayThemeSection";
import { OverlayScenesSection } from "./OverlayScenesSection";
import { OverlayAgentUpsell } from "@/components/instant/AgentLiveUpsell";
import { ConnectionCheck, StuckWidgetHelp } from "./OverlayConnectionCheck";
import { ActiveTokenHeader, AllInOneRow } from "./OverlayTokenHeader";
import { OverlayManagerNav } from "./OverlayManagerNav";
import { OverlayStarterPacks } from "./OverlayStarterPacks";
import { OverlayHealthProvider } from "@/components/overlay/OverlayHealthContext";
import { useSettingsStreamingToken } from "./SettingsStreamingTokenOwner";
import { OverlayHealthBoard } from "./OverlayHealthBoard";

/**
 * Settings · Overlay tab.
 *
 * The admitted shared streaming owner supplies the selected token. This body
 * contains only OBS setup, widgets, look and scenes; Chat owns its actual forms.
 */

export function SettingsOverlay({ origin }: { origin?: string }) {
  const { ownerId: userId, token: activeToken, section, getToken: readToken, isCurrent, refresh: mutate, patchToken } = useSettingsStreamingToken();
  const live = useRef(true);
  const request = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    live.current = true;
    return () => { live.current = false; request.current?.abort(); };
  }, []);
  const current = useCallback(() => live.current && isCurrent(), [isCurrent]);
  const getToken = useCallback(async () => {
    if (!current()) throw new Error("Selected token changed");
    const bearer = await readToken();
    if (!current()) throw new Error("Selected token changed");
    return bearer;
  }, [current, readToken]);
  const { toast } = useToast();
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const { testingWidget, pendingLiveTest, setPendingLiveTest, testWidget } = useOverlayTests(getToken, toast);
  const { config: ghostConfig } = useGhostPractice();
  async function toggleWidget(token: string, widget: string, on: boolean) {
    if (!current() || request.current || token !== activeToken.token) return;
    const controller = new AbortController(); request.current = controller;
    const admitted = () => current() && request.current === controller && !controller.signal.aborted;
    setBusyToken(token);
    try {
      await boundedApiRequest(signal => apiCall(getToken, `/v1/overlay-tokens/${encodeURIComponent(token)}/widgets`, {
        method: "PATCH", body: JSON.stringify({ widget, enabled: on }), signal,
      }), 15_000, controller.signal);
      if (admitted()) await mutate();
    } catch (failure) {
      if (admitted()) toast.error("Couldn't update widget", { description: (failure as ClientApiError)?.message || "Please try again." });
    } finally {
      if (admitted()) setBusyToken(null);
      if (request.current === controller) request.current = null;
    }
  }
  return (
    <OverlayProfileEditor key={`${userId}:${activeToken.token}`} token={activeToken} onSaved={saved => { if (current()) patchToken(saved); }}>{({ profile, saving: profileSaving, setTheme, setDuration }) => <OverlayHealthProvider token={activeToken.token} enabledWidgets={activeToken.enabledWidgets} enabled={section === "setup" || section === "widgets"}><div className="space-y-6">
      <OverlayManagerNav section={section} />
      <div hidden={section !== "setup" && section !== "widgets"}><OverlayHealthBoard /></div>
      <div hidden={section !== "setup"} className="space-y-6">
      {/* Browser-import users without a paired agent: the overlay's live data needs it. */}
      <OverlayAgentUpsell />
      <details className="rounded-lg border border-border px-4 py-2">
        <summary className="cursor-pointer text-body font-medium text-text">Build your first stream setup</summary>
        <Link href="/stream-studio/learn" target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-11 items-center gap-2 text-caption text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Open the Stream Studio crash course<span className="sr-only"> (opens in a new tab)</span><ArrowUpRight className="h-4 w-4" aria-hidden /></Link>
      </details>
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

      <div hidden={section !== "scenes"}>
      <OverlayScenesSection
        token={activeToken.token}
        origin={origin}
        theme={profile.theme}
      />
      </div>

      <div hidden={section !== "look"} className="space-y-6">
      <SettingsBuildProfile key={activeToken.token} token={activeToken.token} />
      <Section
        title="Ghost Build coach"
        description="Choose an account-synced timed build for each exact matchup. Your Ghost source URL stays the same."
      >
        <Card>
          <GhostPracticeSettings />
        </Card>
      </Section>

      <fieldset className="min-w-0 max-w-full" disabled={profileSaving}><OverlayThemeSection theme={profile.theme} onChange={setTheme} /></fieldset>
      </div>

      <OverlayLiveTestDialog pending={pendingLiveTest} busy={testingWidget !== null} origin={origin}
        onClose={() => setPendingLiveTest(null)} onSend={() => { if (pendingLiveTest) void testWidget(pendingLiveTest.token, pendingLiveTest.widget, true); }} />
    </div></OverlayHealthProvider>}</OverlayProfileEditor>
  );
}
