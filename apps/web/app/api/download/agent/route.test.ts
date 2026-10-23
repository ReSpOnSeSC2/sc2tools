import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { afterMock, forwardAgentDownloadEventMock } = vi.hoisted(() => ({
  afterMock: vi.fn(),
  forwardAgentDownloadEventMock: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (...args: unknown[]) => afterMock(...args) };
});

vi.mock("@/lib/agentDownloadEvents.server", () => ({
  forwardAgentDownloadEvent: (...args: unknown[]) =>
    forwardAgentDownloadEventMock(...args),
}));

const attribution = vi.hoisted(() => ({ token:vi.fn(async()=>"signed-in-token"), auth:vi.fn(), record:vi.fn(async(_token:string|null)=>{}) }));
vi.mock("@clerk/nextjs/server",()=>({auth:(...args:unknown[])=>attribution.auth(...args)}));
vi.mock("@/lib/activationDownload.server",()=>({recordAuthenticatedDownload:(token:string|null)=>attribution.record(token)}));

import { dynamic, POST } from "./route";

const INSTALLER_URL =
  "https://github.com/ReSpOnSeSC2/sc2tools/releases/download/agent-v0.15.20/SC2ToolsAgent-Setup-0.15.20.exe";

describe("POST /api/download/agent", () => {
  beforeEach(() => {
    attribution.auth.mockReset().mockResolvedValue({getToken:attribution.token});
    attribution.token.mockClear();attribution.record.mockClear();
    afterMock.mockReset();
    forwardAgentDownloadEventMock.mockReset();
    forwardAgentDownloadEventMock.mockResolvedValue(true);
  });

  it("schedules the event and immediately redirects without caching", async () => {
    const req = request(INSTALLER_URL, {
      "user-agent": "test browser",
      "x-forwarded-for": "203.0.113.42",
    });

    const res = await POST(req);

    expect(dynamic).toBe("force-dynamic");
    expect(afterMock).toHaveBeenCalledOnce();
    expect(forwardAgentDownloadEventMock).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(INSTALLER_URL);
    expect(res.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );

    const scheduled = afterMock.mock.calls[0][0] as () => Promise<boolean>;
    await scheduled();
    expect(forwardAgentDownloadEventMock).toHaveBeenCalledOnce();
    const [eventRequest, payload] = forwardAgentDownloadEventMock.mock.calls[0] as [
      { headers: Headers },
      Record<string, string>,
    ];
    expect(eventRequest.headers.get("user-agent")).toBe("test browser");
    expect(eventRequest.headers.get("x-forwarded-for")).toBe("203.0.113.42");
    expect(payload).toEqual({
      platform: "windows",
      version: "0.15.20",
      channel: "stable",
    });
  });

  it("attributes a real signed-in hand-off only after response and keeps ordinary event delivery", async () => {
    const res=await POST(request(INSTALLER_URL,{cookie:"__session=test-session"}));expect(res.status).toBe(303);
    expect(attribution.token).toHaveBeenCalledOnce();expect(attribution.record).not.toHaveBeenCalled();
    await afterMock.mock.calls[0][0]();expect(attribution.record).toHaveBeenCalledWith("signed-in-token");expect(forwardAgentDownloadEventMock).toHaveBeenCalledOnce();
  });
  it("never blocks the installer if signed-in attribution cannot authenticate", async () => {
    attribution.auth.mockRejectedValueOnce(new Error("session unavailable"));
    const res=await POST(request(INSTALLER_URL,{cookie:"__session=test-session"}));expect(res.status).toBe(303);
    await afterMock.mock.calls[0][0]();expect(attribution.record).toHaveBeenCalledWith(null);expect(forwardAgentDownloadEventMock).toHaveBeenCalledOnce();
  });

  it("rejects untrusted redirect targets without recording", async () => {
    const res = await POST(
      request("https://attacker.example/SC2ToolsAgent-Setup-0.15.20.exe"),
    );

    expect(res.status).toBe(400);
    expect(afterMock).not.toHaveBeenCalled();
    expect(forwardAgentDownloadEventMock).not.toHaveBeenCalled();
  });

  it("rejects non-agent assets from the trusted repository", async () => {
    const res = await POST(
      request(
        "https://github.com/ReSpOnSeSC2/sc2tools/releases/download/agent-v0.15.20/source.zip",
      ),
    );

    expect(res.status).toBe(400);
    expect(afterMock).not.toHaveBeenCalled();
  });
});

function request(
  artifactUrl: string,
  headers?: Record<string, string>,
): NextRequest {
  const body = new FormData();
  body.set("platform", "windows");
  body.set("artifactUrl", artifactUrl);
  return new NextRequest("https://sc2tools.test/api/download/agent", {
    method: "POST",
    headers,
    body,
  });
}
