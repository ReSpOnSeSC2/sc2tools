"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiCall, useApi, useOwnerRequestScope } from "@/lib/clientApi";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/useConfirm";

type OfficialPlatform = "twitch" | "kick" | "youtube";

type ConnectionStatus = {
  platform: OfficialPlatform;
  configured: boolean;
  streamingAvailable?: boolean;
  streamingConsent?: boolean;
  connected: boolean;
  ready: boolean;
  platformUserName: string;
  scopes: string[];
  connectedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
};

type ConnectionsResponse = { platforms: ConnectionStatus[] };
type DisconnectScope = {
  owner: string | null; revision: string; active: boolean;
  pending: boolean; controller: AbortController | null;
};
type DisconnectOperation = {
  source: DisconnectScope; successor: DisconnectScope | null;
  expectedRevision: string | null; published: boolean; active: boolean; controller: AbortController;
};

function isConnectionsResponse(value: unknown): value is ConnectionsResponse {
  if (!value || typeof value !== "object" || !Array.isArray((value as ConnectionsResponse).platforms)) return false;
  const rows = (value as ConnectionsResponse).platforms;
  const seen = new Set<string>();
  return rows.length === 3 && rows.every((row) => {
    if (!row || typeof row !== "object" || !["twitch", "kick", "youtube"].includes(row.platform) || seen.has(row.platform)
      || typeof row.configured !== "boolean" || typeof row.connected !== "boolean" || typeof row.ready !== "boolean"
      || typeof row.platformUserName !== "string" || !Array.isArray(row.scopes) || !row.scopes.every((scope) => typeof scope === "string")
      || !(row.connectedAt === null || typeof row.connectedAt === "string")
      || !(row.lastSyncedAt === null || typeof row.lastSyncedAt === "string")
      || !(row.lastError === null || typeof row.lastError === "string")
      || !(row.streamingAvailable === undefined || typeof row.streamingAvailable === "boolean")
      || !(row.streamingConsent === undefined || typeof row.streamingConsent === "boolean")) return false;
    seen.add(row.platform); return true;
  });
}

function connectionRevision(data: ConnectionsResponse | undefined) {
  return JSON.stringify((["twitch", "kick", "youtube"] as OfficialPlatform[]).map((platform) => {
    const row = data?.platforms.find((item) => item.platform === platform);
    return [platform, row?.connected === true, row?.connectedAt ?? null];
  }));
}

const COPY: Record<OfficialPlatform, { label: string; coverage: string }> = {
  twitch: {
    label: "Twitch",
    coverage: "Adds signed follows, channel-point rewards, subs, resubs, gift subs, cheers and incoming raids. Live-chat copies are paired automatically, so each action appears once.",
  },
  kick: {
    label: "Kick",
    coverage: "Adds signed follows, channel rewards, new and renewed subscriptions, gifted subs and KICKs gifts. Live-chat copies are paired automatically.",
  },
  youtube: {
    label: "YouTube",
    coverage: "Adds free channel-subscription alerts for subscribers who keep their subscriptions public. YouTube hides private subscriptions.",
  },
};

export function OfficialPlatformConnections() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const { toast } = useToast();
  const { data, isLoading, error, mutate } = useApi<ConnectionsResponse>(
    "/v1/me/integrations",
    { refreshInterval: 60_000 },
  );
  const [busy, setBusy] = useState<OfficialPlatform | null>(null);
  const revision = connectionRevision(data);
  const operationRef = useRef<DisconnectOperation | null>(null);
  const scopeRef = useRef<DisconnectScope>({ owner, revision, active: !!owner, pending: false, controller: null });
  let scope = scopeRef.current;
  if (scope.owner !== owner || scope.revision !== revision) {
    const previous = scope;
    scope.active = false;
    scope = { owner, revision, active: !!owner, pending: false, controller: null };
    scopeRef.current = scope;
    const operation = operationRef.current;
    if (operation?.active) {
      if (operation.source === previous && !operation.successor
        && operation.expectedRevision === revision && owner === previous.owner) {
        // Admit exactly our expected cache publication, once. Returning to
        // these same values after another transition cannot revive this intent.
        operation.successor = scope; scope.pending = true; scope.controller = operation.controller;
      } else operation.active = false;
    }
  }
  useLayoutEffect(() => {
    scope.active = !!owner;
    return () => {
      scope.active = false;
      const operation = operationRef.current;
      const handedOff = operation?.active && operation.source === scope
        && operation.successor === scopeRef.current && scopeRef.current.active;
      if (!handedOff) {
        if (operation && (operation.source === scope || operation.successor === scope)) operation.active = false;
        scope.controller?.abort();
      }
    };
  }, [scope, owner]);
  const { confirm, dialog } = useConfirm(scope);
  const runOwned = useOwnerRequestScope(owner, getToken);
  const requestRef = useRef(runOwned); requestRef.current = runOwned;
  const [disconnecting, setDisconnecting] = useState<{ operation: DisconnectOperation; platform: OfficialPlatform } | null>(null);
  const activeDisconnect = disconnecting?.operation === operationRef.current && disconnecting?.operation.active
    && (disconnecting.operation.source === scope || disconnecting.operation.successor === scope) ? disconnecting : null;
  const actionBusy = busy !== null || !!activeDisconnect;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const connect = async (platform: OfficialPlatform, purpose: "alerts" | "streaming" = "alerts") => {
    const baselineConnectedAt = data?.platforms.find(
      (item) => item.platform === platform,
    )?.connectedAt || null;
    // Open synchronously from the click so popup blockers do not swallow the
    // OAuth window while the authenticated API request is in flight.
    const popup = window.open("", "sc2tools-platform-connect", "popup,width=620,height=760");
    if (!popup) {
      toast.error("Your browser blocked the connection window", {
        description: "Allow popups for SC2 Tools, then try again.",
      });
      return;
    }
    popup.document.title = `Connect ${COPY[platform].label}`;
    popup.document.body.textContent = `Opening ${COPY[platform].label}…`;
    setBusy(platform);
    try {
      const result = await apiCall<{ authorizeUrl: string }>(
        getToken,
        `/v1/me/integrations/${platform}/connect`,
        { method: "POST", body: purpose === "streaming" ? JSON.stringify({ purpose }) : "{}" },
      );
      popup.location.replace(result.authorizeUrl);
      let lastPollError: unknown = null;
      for (let attempt = 0; attempt < 45; attempt += 1) {
        await wait(2_000);
        if (!mounted.current) return;
        let fresh: ConnectionsResponse;
        try {
          fresh = await apiCall<ConnectionsResponse>(
            getToken,
            "/v1/me/integrations",
          );
          lastPollError = null;
        } catch (err) {
          // A brief API/network interruption should not cancel a provider flow
          // the viewer may still be completing in the popup.
          lastPollError = err;
          if (popup.closed) break;
          continue;
        }
        await mutate(fresh, false);
        const row = fresh.platforms.find((item) => item.platform === platform);
        // A reconnect starts while the old row is still connected. Only treat
        // a status as this popup's result after the callback installs a fresh
        // connection revision (represented publicly by connectedAt).
        const completedThisFlow = Boolean(
          row?.connectedAt && row.connectedAt !== baselineConnectedAt,
        );
        if (purpose === "streaming" && completedThisFlow && row?.connected && row.streamingConsent) {
          popup.close();
          toast.success(`${COPY[platform].label} stream controls connected`, {
            description: "Return to the SC2Tools agent to set your stream title and prepare supported sessions.",
          });
          return;
        }
        if (completedThisFlow && row?.connected && row.ready) {
          popup.close();
          if (row.lastError) {
            toast.error(`${COPY[platform].label} connected, but alerts need a retry`, {
              description: row.lastError,
            });
          } else {
            toast.success(`${COPY[platform].label} connected`, {
              description: "Supported notifications will now appear on stream and in Stream Dock.",
            });
          }
          return;
        }
        if (completedThisFlow && row?.connected && row.lastError) {
          popup.close();
          toast.error(`${COPY[platform].label} connected, but alerts need a retry`, {
            description: row.lastError,
          });
          return;
        }
        if (popup.closed) break;
      }
      await mutate();
      popup.close();
      toast.error(`${COPY[platform].label} connection was not completed`, {
        description: lastPollError
          ? "Connection status was temporarily unavailable. Check the account status below and retry if needed."
          : undefined,
      });
    } catch (err) {
      popup.close();
      toast.error(`Could not connect ${COPY[platform].label}`, {
        description: errorMessage(err),
      });
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const disconnect = async (platform: OfficialPlatform) => {
    const requestOwner = scope.owner;
    const current = () => mounted.current && scope.active && scopeRef.current === scope && !scope.controller?.signal.aborted;
    if (!requestOwner || !current() || actionBusy || scope.pending
      || !data?.platforms.some((item) => item.platform === platform && item.connected)) return;
    scope.pending = true;
    let operation: DisconnectOperation | null = null;
    try {
      const accepted = await confirm({
        title: `Disconnect ${COPY[platform].label}?`,
        description: `Disconnect your ${COPY[platform].label} account? This stops its notifications and stream controls.`,
        confirmLabel: `Disconnect ${COPY[platform].label}`,
        intent: "danger", focusCancel: true,
      });
      if (!accepted || !current()) return;
      const controller = new AbortController(); scope.controller = controller;
      const requestOperation: DisconnectOperation = { source: scope, successor: null, expectedRevision: null, published: false, active: true, controller };
      operation = requestOperation; operationRef.current = requestOperation;
      const admitted = () => mounted.current && operationRef.current === requestOperation && requestOperation.active
        && scopeRef.current.active && !controller.signal.aborted
        && (scopeRef.current === requestOperation.source || scopeRef.current === requestOperation.successor);
      setDisconnecting({ operation: requestOperation, platform });
      const result = await requestRef.current(requestOwner, async (scopedToken, signal, assertCurrent) => {
        const assertResource = () => {
          assertCurrent();
          if (!current()) throw new DOMException("This connection changed.", "AbortError");
        };
        const token = async () => {
          assertResource(); const value = await scopedToken(); assertResource();
          if (!value) throw new Error("Sign in again before disconnecting this account.");
          return value;
        };
        await apiCall(token, `/v1/me/integrations/${platform}`, { method: "DELETE", signal });
        assertResource();
        // Same single status read as revalidation, inside the JWT/body deadline.
        const fresh = await apiCall<ConnectionsResponse>(token, "/v1/me/integrations", { signal });
        assertResource();
        if (!isConnectionsResponse(fresh) || fresh.platforms.find((item) => item.platform === platform)?.connected !== false) {
          throw new Error("The account status has not confirmed that this connection is disconnected.");
        }
        return { fresh, assertOwner: assertCurrent };
      }, 20_000, controller.signal);
      if (!current()) return;
      requestOperation.expectedRevision = connectionRevision(result.fresh);
      // SWR may invoke this updater later. A retired decision cannot publish
      // an older disconnected snapshot over a newer connection's cached row.
      await mutate((cached: ConnectionsResponse | undefined) => {
        if (!admitted()) return cached;
        if (!isConnectionsResponse(cached)) { requestOperation.active = false; return cached; }
        const cachedRevision = connectionRevision(cached);
        if (cachedRevision !== requestOperation.source.revision && cachedRevision !== requestOperation.expectedRevision) {
          requestOperation.active = false;
          return cached;
        }
        requestOperation.published = true;
        return result.fresh;
      }, false);
      result.assertOwner();
      if (!admitted() || !requestOperation.published) return;
      toast.success(`${COPY[platform].label} disconnected`);
    } catch (err) {
      if (!current() || err instanceof DOMException && err.name === "AbortError") return;
      toast.error(`Could not confirm ${COPY[platform].label} disconnection`, {
        description: `${errorMessage(err)} Check this account's status before trying again.`,
      });
    } finally {
      scope.pending = false; scope.controller = null;
      if (operation) {
        operation.active = false;
        if (operation.successor) { operation.successor.pending = false; operation.successor.controller = null; }
        if (operationRef.current === operation) operationRef.current = null;
      }
      if (mounted.current && scopeRef.current.active && (scopeRef.current === scope || scopeRef.current === operation?.successor)) {
        setDisconnecting(previous => previous?.operation === operation ? null : previous);
      }
    }
  };

  return (
    // `id`: the OAuth return page links back here
    // (/settings?tab=overlay#platform-connections).
    <div
      id="platform-connections"
      className="scroll-mt-20 space-y-3 rounded-lg border border-border bg-bg-elevated/40 p-3"
    >
      <div>
        <div className="text-body font-medium text-text">Connected accounts</div>
        <p className="mt-1 text-caption text-text-dim">
          Notifications and stream controls have separate permissions. Stream controls
          let SC2Tools update titles and prepare YouTube broadcasts.
        </p>
      </div>
      <p className="rounded-md border border-border bg-bg/40 px-3 py-2 text-caption text-text-muted">
        A desktop agent paired to this same SC2Tools account can use its authorized
        stream controls. Agent pairing and OBS output setup are separate steps in
        the desktop app.
      </p>
      {isLoading ? (
        <div className="text-caption text-text-muted">Checking connections…</div>
      ) : error && !data ? (
        <div className="flex items-center gap-2 text-caption text-danger">
          Couldn&apos;t check account permissions.
          <Button size="sm" variant="secondary" onClick={() => void mutate()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {(["twitch", "kick", "youtube"] as OfficialPlatform[]).map((platform) => {
            const row = data?.platforms.find((item) => item.platform === platform);
            const configured = row?.configured === true;
            const connected = row?.connected === true;
            const streamControlsAuthorized = connected && row?.streamingConsent === true;
            return (
              <div key={platform} role="group" aria-label={`${COPY[platform].label} account permissions`}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-body font-medium text-text">{COPY[platform].label}</span>
                    {connected && row?.platformUserName ? (
                      <span className="text-caption text-text-muted">{row.platformUserName}</span>
                    ) : null}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    {connected && row?.ready ? (
                      <Badge variant="success" size="sm">Notifications ready</Badge>
                    ) : connected ? (
                      <Badge variant="warning" size="sm">Notifications need retry</Badge>
                    ) : (
                      <Badge variant="neutral" size="sm">
                        {configured ? "Notifications not connected" : "Notifications unavailable"}
                      </Badge>
                    )}
                    <Badge variant={streamControlsAuthorized ? "success" : "neutral"} size="sm">
                      {streamControlsAuthorized ? "Stream controls authorized"
                        : configured && row?.streamingAvailable === true
                          ? "Stream controls need permission" : "Stream controls unavailable"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-caption text-text-dim">{COPY[platform].coverage}</p>
                  {row?.lastError ? (
                    <p className="mt-1 text-caption text-danger">{row.lastError}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                {connected ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={actionBusy}
                      onClick={() => void connect(platform, row?.streamingConsent ? "streaming" : "alerts")}
                    >
                      Reconnect
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!owner || actionBusy}
                      loading={activeDisconnect?.platform === platform}
                      onClick={() => void disconnect(platform)}
                    >
                      Disconnect
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!configured || actionBusy}
                    onClick={() => void connect(platform)}
                  >
                    {busy === platform ? "Connecting…" : "Connect"}
                  </Button>
                )}
                {!streamControlsAuthorized ? (
                  <Button size="sm" variant="secondary"
                    disabled={!configured || row?.streamingAvailable !== true || actionBusy}
                    onClick={() => void connect(platform, "streaming")}
                  >
                    Connect stream controls
                  </Button>
                ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-micro text-text-muted">
        TikTok chat, follows, gifts/diamonds, shares and likes continue through
        the live TikTok connection above; TikTok does not provide a public
        creator webhook connection for these LIVE events.
      </p>
      {dialog}
    </div>
  );
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function errorMessage(err: unknown) {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Try again in a moment.";
}
