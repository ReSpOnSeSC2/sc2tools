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
import { OverlayStarterPacks } from "./OverlayStarterPacks";
import { OverlayHealthProvider } from "@/components/overlay/OverlayHealthContext";
import { useSettingsStreamingToken } from "./SettingsStreamingTokenOwner";
import { OverlayHealthBoard } from "./OverlayHealthBoard";
import { GuidedTours } from "@/components/onboarding/GuidedTours";

/**
 * Settings · Overlay tab.
 *
 * The admitted shared streaming owner supplies the selected token. This body
 * contains only OBS setup, widgets, look and scenes; Chat owns its actual forms.
 */

export function SettingsOverlay({ origin }: { origin?: string }) {
  const { ownerId: userId, token: activeToken, credential, getToken: readToken, isCurrent, refresh: mutate, patchToken } = useSettingsStreamingToken();
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
    <OverlayProfileEditor key={`${userId}:${activeToken.token}`} token={activeToken} onSaved={saved => { if (current()) patchToken(saved); }}>{({ profile, saving: profileSaving, setTheme, setDuration }) => <GuidedTours id="overlay" recordKey={String(credential.key)} ready={current()} isCurrent={current} className="space-y-6">
      <header><h2 className="text-body-lg font-semibold text-text">Overlay</h2>
        <Link href="/stream-studio/learn" target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-11 items-center gap-2 text-caption text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Build your first stream setup<span className="sr-only"> (opens in a new tab)</span><ArrowUpRight className="h-4 w-4" aria-hidden /></Link>
      </header>
      {/* One visibility host covers only Setup/Widgets, never Theme or Scenes. */}
      <OverlayHealthProvider token={activeToken.token} enabledWidgets={activeToken.enabledWidgets} enabled><div className="space-y-6">
      <Section id="setup" data-tour="overlay-setup" className="scroll-mt-28"
        title="OBS Browser Source URLs"
        description="Copy the URLs you want into OBS. Each widget is transparent and positioned independently. The URLs share the same socket connection so your overlay stays in sync."
      >
      <div className="space-y-6">
      <OverlayHealthBoard />
      {/* Browser-import users without a paired agent: the overlay's live data needs it. */}
      <OverlayAgentUpsell />
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
                className="text-accent-cyan underline underline-offset-2 hover:underline"
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
        </Card>
        <ConnectionCheck token={activeToken.token} lastSeenAt={activeToken.lastSeenAt} /><StuckWidgetHelp />
      </div>
      </Section>
      <Section id="widgets" data-tour="overlay-widgets" className="scroll-mt-28" title="Widgets" description="Choose, size and test individual OBS sources.">
        <div className="space-y-6">
          <OverlayStarterPacks key={`${userId}:${activeToken.token}`} token={activeToken} onUpdated={() => mutate()} />
          <Card padded={false}><WidgetList
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
          /></Card>
        </div>
      </Section>
      </div></OverlayHealthProvider>

      <OverlayScenesSection
        token={activeToken.token}
        origin={origin}
        theme={profile.theme}
      />

      <SettingsBuildProfile key={activeToken.token} token={activeToken.token} />
      <Section id="ghost-coach" className="scroll-mt-28"
        title="Ghost Build coach"
        description="Choose an account-synced timed build for each exact matchup. Your Ghost source URL stays the same."
      >
        <Card>
          <GhostPracticeSettings />
        </Card>
      </Section>

      <fieldset className="min-w-0 max-w-full" disabled={profileSaving}><OverlayThemeSection theme={profile.theme} onChange={setTheme} /></fieldset>

      <OverlayLiveTestDialog pending={pendingLiveTest} busy={testingWidget !== null} origin={origin}
        onClose={() => setPendingLiveTest(null)} onSend={() => { if (pendingLiveTest) void testWidget(pendingLiveTest.token, pendingLiveTest.widget, true); }} />
    </GuidedTours>}</OverlayProfileEditor>
  );
}
