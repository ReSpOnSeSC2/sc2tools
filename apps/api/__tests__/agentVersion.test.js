// @ts-nocheck
"use strict";

const { compareVersions, AgentVersionService } = require("../src/services/agentVersion");

describe("services/agentVersion", () => {
  describe("compareVersions", () => {
    test.each([
      ["1.0.0", "1.0.0", 0],
      ["0.9.9", "1.0.0", -1],
      ["1.0.1", "1.0.0", 1],
      ["1.10.0", "1.2.0", 1],
      ["1.0.0-beta", "1.0.0", 0], // pre-release suffix ignored
      ["abc", "1.0.0", 0], // unparseable -> 0
    ])("compareVersions(%p, %p) === %p", (a, b, expected) => {
      expect(compareVersions(a, b)).toBe(expected);
    });
  });

  describe("AgentVersionService.publish validation", () => {
    function buildService(initial = []) {
      const docs = [...initial];
      const collection = {
        async updateOne(filter, update, opts) {
          const idx = docs.findIndex(
            (d) => d.channel === filter.channel && d.version === filter.version,
          );
          const setDoc = update.$set;
          if (idx >= 0) {
            docs[idx] = { ...docs[idx], ...setDoc };
          } else if (opts && opts.upsert) {
            docs.push({ ...setDoc, ...(update.$setOnInsert || {}) });
          }
        },
        async findOne() {
          return null;
        },
        find() {
          return {
            sort: () => ({
              limit: () => ({
                toArray: () => Promise.resolve(docs.slice()),
              }),
            }),
          };
        },
      };
      return new AgentVersionService({ agentReleases: collection });
    }

    test("rejects bad channel", async () => {
      const svc = buildService();
      await expect(
        svc.publish({
          channel: "garbage",
          version: "1.0.0",
          artifacts: validArtifacts(),
        }),
      ).rejects.toThrow(/invalid channel/);
    });

    test("rejects non-semver version", async () => {
      const svc = buildService();
      await expect(
        svc.publish({
          channel: "stable",
          version: "x.y.z",
          artifacts: validArtifacts(),
        }),
      ).rejects.toThrow(/semver/);
    });

    test("rejects empty artifacts", async () => {
      const svc = buildService();
      await expect(
        svc.publish({ channel: "stable", version: "1.0.0", artifacts: [] }),
      ).rejects.toThrow(/artifacts required/);
    });

    test("rejects non-https url", async () => {
      const svc = buildService();
      await expect(
        svc.publish({
          channel: "stable",
          version: "1.0.0",
          artifacts: [
            {
              platform: "windows",
              downloadUrl: "ftp://example.com/x",
              sha256: "a".repeat(64),
            },
          ],
        }),
      ).rejects.toThrow(/http\(s\)/);
    });

    test("accepts a well-formed payload", async () => {
      const svc = buildService();
      const out = await svc.publish({
        channel: "stable",
        version: "1.2.3",
        releaseNotes: "ok",
        artifacts: validArtifacts(),
      });
      expect(out).toEqual({ channel: "stable", version: "1.2.3" });
    });

    test("rejects bad sha256 hex length", async () => {
      const svc = buildService();
      await expect(
        svc.publish({
          channel: "stable",
          version: "1.0.0",
          artifacts: [
            {
              platform: "windows",
              downloadUrl: "https://example.com/x.exe",
              sha256: "abc",
            },
          ],
        }),
      ).rejects.toThrow(/sha256/);
    });
  });
});

function validArtifacts() {
  return [
    {
      platform: "windows",
      downloadUrl: "https://example.com/agent-1.0.0.exe",
      sha256: "a".repeat(64),
      sizeBytes: 12345,
    },
  ];
}
