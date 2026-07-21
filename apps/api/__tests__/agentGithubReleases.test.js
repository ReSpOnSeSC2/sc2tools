// @ts-nocheck
"use strict";

const { GithubReleaseFeed } = require("../src/services/agentGithubReleases");
const { AgentVersionService } = require("../src/services/agentVersion");

const SHA = "ea423015227bd2bdbf8c2d75a938d5213f58829e9f5adf78a4c8640ba5b3aaaa";

function ghRelease(version, overrides = {}) {
  const exeName = `SC2ToolsAgent-Setup-${version}.exe`;
  return {
    tag_name: `agent-v${version}`,
    body: `notes for ${version}`,
    draft: false,
    prerelease: false,
    published_at: "2026-07-11T00:43:00Z",
    assets: [
      {
        name: exeName,
        browser_download_url: `https://example.com/${exeName}`,
        size: 1000,
      },
      {
        name: `${exeName}.sha256`,
        browser_download_url: `https://example.com/${exeName}.sha256`,
        size: 98,
      },
    ],
    ...overrides,
  };
}

/**
 * fetch double: /releases returns `releases`; *.sha256 URLs return
 * `shaText`. Records calls so cache behaviour is assertable.
 */
function fakeFetch(releases, { shaText = `${SHA}  installer.exe`, fail = false } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (fail) throw new Error("network down");
    if (String(url).includes("/releases?")) {
      return { ok: true, json: async () => releases, text: async () => "" };
    }
    return { ok: true, json: async () => ({}), text: async () => shaText };
  };
  impl.calls = calls;
  return impl;
}

describe("services/agentGithubReleases", () => {
  test("resolves the newest eligible release with sidecar sha256", async () => {
    // Lexicographic tag order would pick 0.9.4 over 0.13.3 — the feed
    // must sort by semver, mirroring the website route's fix.
    const feed = new GithubReleaseFeed({
      owner: "o",
      repo: "r",
      fetchImpl: fakeFetch([ghRelease("0.9.4"), ghRelease("0.13.3")]),
    });
    const out = await feed.latest({ channel: "stable", platform: "windows" });
    expect(out).toMatchObject({
      channel: "stable",
      version: "0.13.3",
      source: "github",
      artifact: {
        platform: "windows",
        downloadUrl: "https://example.com/SC2ToolsAgent-Setup-0.13.3.exe",
        sha256: SHA,
        sizeBytes: 1000,
      },
    });
  });

  test("skips drafts, prereleases, and releases without an installer asset", async () => {
    const feed = new GithubReleaseFeed({
      owner: "o",
      repo: "r",
      fetchImpl: fakeFetch([
        ghRelease("0.14.0", { draft: true }),
        ghRelease("0.13.9", { prerelease: true }),
        ghRelease("0.13.8", { assets: [] }),
        ghRelease("0.13.3"),
      ]),
    });
    const out = await feed.latest();
    expect(out.version).toBe("0.13.3");
  });

  test("refuses to offer a release whose sha256 sidecar is missing", async () => {
    const noSidecar = ghRelease("0.13.3");
    noSidecar.assets = noSidecar.assets.filter((a) => !a.name.endsWith(".sha256"));
    const feed = new GithubReleaseFeed({
      owner: "o",
      repo: "r",
      fetchImpl: fakeFetch([noSidecar]),
    });
    // The agent hard-verifies sha256; offering an unverifiable
    // artifact would make every poll download + fail forever.
    expect(await feed.latest()).toBeNull();
  });

  test("walks down to an older verifiable release when the newest lacks a sidecar", async () => {
    const noSidecar = ghRelease("0.15.8");
    noSidecar.assets = noSidecar.assets.filter((a) => !a.name.endsWith(".sha256"));
    const feed = new GithubReleaseFeed({
      owner: "o",
      repo: "r",
      fetchImpl: fakeFetch([noSidecar, ghRelease("0.15.5")]),
    });
    // Blanking the whole feed here would drop to Mongo, which may be
    // staler than the still-verifiable previous GitHub release.
    expect((await feed.latest()).version).toBe("0.15.5");
  });

  test("uses the asset's server-computed digest without fetching the sidecar", async () => {
    const rel = ghRelease("0.13.3");
    rel.assets[0].digest = `sha256:${SHA.toUpperCase()}`;
    const impl = fakeFetch([rel]);
    const feed = new GithubReleaseFeed({ owner: "o", repo: "r", fetchImpl: impl });
    const out = await feed.latest();
    expect(out.artifact.sha256).toBe(SHA);
    // Only the releases-list fetch — no sidecar download.
    expect(impl.calls).toHaveLength(1);
    expect(String(impl.calls[0])).toContain("/releases?");
  });

  test("caches briefly while a newer published release awaits its installer", async () => {
    // The publish→asset-upload window: agent-v0.15.8 exists but the
    // workflow hasn't attached the .exe yet. Serving 0.15.5 is right,
    // but it must not be cached for the full TTL — the assets land
    // minutes later.
    const pending = ghRelease("0.15.8", { assets: [] });
    const impl = fakeFetch([pending, ghRelease("0.15.5")]);
    const feed = new GithubReleaseFeed({
      owner: "o",
      repo: "r",
      ttlMs: 60_000,
      pendingTtlMs: 0, // pending entries expire immediately in this test
      fetchImpl: impl,
    });
    expect((await feed.latest()).version).toBe("0.15.5");
    const callsAfterFirst = impl.calls.length;
    expect((await feed.latest()).version).toBe("0.15.5");
    expect(impl.calls.length).toBeGreaterThan(callsAfterFirst); // re-resolved

    // Control: no pending release → second call served from cache.
    const impl2 = fakeFetch([ghRelease("0.15.5")]);
    const settled = new GithubReleaseFeed({
      owner: "o",
      repo: "r",
      ttlMs: 60_000,
      pendingTtlMs: 0,
      fetchImpl: impl2,
    });
    await settled.latest();
    const calls2AfterFirst = impl2.calls.length;
    await settled.latest();
    expect(impl2.calls.length).toBe(calls2AfterFirst); // cache hit
  });

  test("stops serving stale past staleMaxMs and falls back to null", async () => {
    const feed = new GithubReleaseFeed({
      owner: "o",
      repo: "r",
      ttlMs: 0,
      staleMaxMs: 0, // stale entries are immediately too old in this test
      fetchImpl: (...args) => feed.fetchImpl2(...args),
    });
    feed.fetchImpl2 = fakeFetch([ghRelease("0.13.3")]);
    expect((await feed.latest()).version).toBe("0.13.3");
    feed.fetchImpl2 = fakeFetch([], { fail: true });
    // A persistently failing refresh (e.g. unauthenticated rate
    // limiting) must not pin an old snapshot forever — the caller
    // falls back to Mongo alone.
    expect(await feed.latest()).toBeNull();
  });

  test("revalidates with If-None-Match and reuses the body on 304", async () => {
    const calls = [];
    const releases = [ghRelease("0.13.3")];
    const impl = async (url, opts = {}) => {
      calls.push({ url: String(url), headers: opts.headers || {} });
      if (String(url).includes("/releases?")) {
        if (opts.headers && opts.headers["If-None-Match"] === '"etag-1"') {
          return { ok: false, status: 304, headers: { get: () => null } };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: (h) => (h === "etag" ? '"etag-1"' : null) },
          json: async () => releases,
        };
      }
      return { ok: true, status: 200, text: async () => `${SHA}  x.exe` };
    };
    const feed = new GithubReleaseFeed({
      owner: "o",
      repo: "r",
      ttlMs: 0, // every latest() re-resolves
      fetchImpl: impl,
    });
    expect((await feed.latest()).version).toBe("0.13.3");
    expect((await feed.latest()).version).toBe("0.13.3"); // via 304 reuse
    const listCalls = calls.filter((c) => c.url.includes("/releases?"));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0].headers["If-None-Match"]).toBeUndefined();
    expect(listCalls[1].headers["If-None-Match"]).toBe('"etag-1"');
  });

  test("ignores non-agent tags (legacy v* releases stay private)", async () => {
    const feed = new GithubReleaseFeed({
      owner: "o",
      repo: "r",
      fetchImpl: fakeFetch([ghRelease("0.13.3", { tag_name: "v0.13.3" })]),
    });
    expect(await feed.latest()).toBeNull();
  });

  test("caches within the TTL and serves stale on later fetch failure", async () => {
    const good = fakeFetch([ghRelease("0.13.3")]);
    const feed = new GithubReleaseFeed({
      owner: "o",
      repo: "r",
      ttlMs: 0, // every latest() re-resolves — lets us flip the impl
      fetchImpl: (...args) => feed.fetchImpl2(...args),
    });
    feed.fetchImpl2 = good;
    expect((await feed.latest()).version).toBe("0.13.3");
    feed.fetchImpl2 = fakeFetch([], { fail: true });
    // Failure after a successful resolve serves the stale value.
    expect((await feed.latest()).version).toBe("0.13.3");
  });

  test("returns null (not throw) when GitHub is down and nothing is cached", async () => {
    const feed = new GithubReleaseFeed({
      owner: "o",
      repo: "r",
      fetchImpl: fakeFetch([], { fail: true }),
    });
    expect(await feed.latest()).toBeNull();
  });

  test("only serves stable/windows — other channels fall through to Mongo", async () => {
    const feed = new GithubReleaseFeed({
      owner: "o",
      repo: "r",
      fetchImpl: fakeFetch([ghRelease("0.13.3")]),
    });
    expect(await feed.latest({ channel: "beta" })).toBeNull();
    expect(await feed.latest({ platform: "macos" })).toBeNull();
  });
});

describe("AgentVersionService.latest source merge", () => {
  function dbWith(doc) {
    return {
      agentReleases: {
        async findOne() {
          return doc;
        },
      },
    };
  }

  function mongoDoc(version) {
    return {
      channel: "stable",
      version,
      releaseNotes: "curated",
      minSupportedVersion: null,
      publishedAt: new Date("2026-06-26T00:00:00Z"),
      artifacts: [
        {
          platform: "windows",
          downloadUrl: `https://example.com/${version}.exe`,
          sha256: SHA,
          sizeBytes: 5,
        },
      ],
    };
  }

  function feedReturning(release) {
    return { latest: async () => release };
  }

  test("GitHub wins when it is strictly newer than Mongo", async () => {
    const svc = new AgentVersionService(dbWith(mongoDoc("0.13.2")), {
      githubFeed: feedReturning({
        channel: "stable",
        version: "0.13.3",
        source: "github",
        artifact: { platform: "windows", downloadUrl: "u", sha256: SHA },
      }),
    });
    const out = await svc.latest({ channel: "stable", platform: "windows" });
    expect(out.version).toBe("0.13.3");
    expect(out.source).toBe("github");
  });

  test("Mongo wins ties so a manual publish can override generated notes", async () => {
    const svc = new AgentVersionService(dbWith(mongoDoc("0.13.3")), {
      githubFeed: feedReturning({
        channel: "stable",
        version: "0.13.3",
        source: "github",
        artifact: { platform: "windows", downloadUrl: "u", sha256: SHA },
      }),
    });
    const out = await svc.latest({});
    expect(out.releaseNotes).toBe("curated");
    expect(out.source).toBeUndefined();
  });

  test("Mongo wins when GitHub is older", async () => {
    const svc = new AgentVersionService(dbWith(mongoDoc("0.14.0")), {
      githubFeed: feedReturning({
        channel: "stable",
        version: "0.13.3",
        source: "github",
        artifact: { platform: "windows", downloadUrl: "u", sha256: SHA },
      }),
    });
    expect((await svc.latest({})).version).toBe("0.14.0");
  });

  test("GitHub serves alone when the collection is empty", async () => {
    const svc = new AgentVersionService(dbWith(null), {
      githubFeed: feedReturning({
        channel: "stable",
        version: "0.13.3",
        source: "github",
        artifact: { platform: "windows", downloadUrl: "u", sha256: SHA },
      }),
    });
    expect((await svc.latest({})).version).toBe("0.13.3");
  });

  test("Mongo serves alone when the feed is absent or empty", async () => {
    const noFeed = new AgentVersionService(dbWith(mongoDoc("0.13.2")));
    expect((await noFeed.latest({})).version).toBe("0.13.2");
    const emptyFeed = new AgentVersionService(dbWith(mongoDoc("0.13.2")), {
      githubFeed: feedReturning(null),
    });
    expect((await emptyFeed.latest({})).version).toBe("0.13.2");
  });

  test("a throwing feed double never 500s the version route", async () => {
    const svc = new AgentVersionService(dbWith(mongoDoc("0.13.2")), {
      githubFeed: {
        latest: async () => {
          throw new Error("boom");
        },
      },
    });
    expect((await svc.latest({})).version).toBe("0.13.2");
  });
});
