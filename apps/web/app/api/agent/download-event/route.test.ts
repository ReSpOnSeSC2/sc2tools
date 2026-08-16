import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { forwardAgentDownloadEventMock } = vi.hoisted(() => ({
  forwardAgentDownloadEventMock: vi.fn(),
}));

vi.mock("@/lib/agentDownloadEvents.server", () => ({
  forwardAgentDownloadEvent: (...args: unknown[]) =>
    forwardAgentDownloadEventMock(...args),
}));

import { POST } from "./route";

describe("POST /api/agent/download-event", () => {
  beforeEach(() => {
    forwardAgentDownloadEventMock.mockReset();
    forwardAgentDownloadEventMock.mockResolvedValue(true);
  });

  it("keeps forwarding beacons from already-open browser bundles", async () => {
    const req = request(
      JSON.stringify({
        platform: "windows",
        version: "0.15.19",
        channel: "stable",
      }),
    );

    const res = await POST(req);

    expect(res.status).toBe(204);
    expect(forwardAgentDownloadEventMock).toHaveBeenCalledOnce();
    expect(forwardAgentDownloadEventMock).toHaveBeenCalledWith(req, {
      platform: "windows",
      version: "0.15.19",
      channel: "stable",
    });
  });

  it("stays fail-open for a malformed legacy beacon", async () => {
    const req = request("not-json");
    forwardAgentDownloadEventMock.mockResolvedValueOnce(false);

    const res = await POST(req);

    expect(res.status).toBe(204);
    expect(forwardAgentDownloadEventMock).toHaveBeenCalledWith(req, {
      platform: "",
      version: "",
      channel: "stable",
    });
  });
});

function request(body: string): NextRequest {
  return new NextRequest("https://sc2tools.test/api/agent/download-event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}
