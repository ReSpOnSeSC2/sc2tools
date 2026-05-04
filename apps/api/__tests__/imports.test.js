// @ts-nocheck
"use strict";

const { ImportService } = require("../src/services/import");

function makeMockJobs() {
  /** @type {any[]} */
  const docs = [];
  let nextId = 1;
  const collection = {
    async insertOne(doc) {
      const _id = String(nextId++);
      docs.push({ _id, ...doc });
      return { insertedId: _id };
    },
    async findOne(query, opts = {}) {
      const sortKey = opts.sort
        ? Object.keys(opts.sort)[0]
        : null;
      let candidates = docs.filter((d) => matches(d, query));
      if (sortKey) {
        candidates = candidates.slice().sort((a, b) => {
          const av = a[sortKey];
          const bv = b[sortKey];
          const dir = opts.sort[sortKey];
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * dir;
        });
      }
      return candidates[0] || null;
    },
    async updateOne(query, update, opts = {}) {
      const idx = docs.findIndex((d) => matches(d, query));
      if (idx >= 0) {
        const setDoc = update.$set || {};
        docs[idx] = { ...docs[idx], ...setDoc };
      } else if (opts.upsert) {
        docs.push({ _id: String(nextId++), ...(update.$setOnInsert || {}), ...(update.$set || {}) });
      }
      return { matchedCount: idx >= 0 ? 1 : 0, upsertedCount: idx < 0 && opts.upsert ? 1 : 0 };
    },
    find(query) {
      let snapshot = docs.filter((d) => matches(d, query));
      const cursor = {
        sort(spec) {
          const k = Object.keys(spec)[0];
          const dir = spec[k];
          snapshot = snapshot
            .slice()
            .sort((a, b) => {
              const av = a[k];
              const bv = b[k];
              if (av === bv) return 0;
              return (av > bv ? 1 : -1) * dir;
            });
          return cursor;
        },
        limit() {
          return cursor;
        },
        toArray() {
          return Promise.resolve(snapshot.slice());
        },
      };
      return cursor;
    },
  };
  return { collection, docs };
}

function matches(doc, query) {
  if (!query) return true;
  for (const key of Object.keys(query)) {
    const expected = query[key];
    if (typeof expected === "object" && expected !== null) {
      if ("$in" in expected) {
        if (!expected.$in.includes(doc[key])) return false;
      } else if ("$exists" in expected) {
        const present = doc[key] !== undefined;
        if (present !== expected.$exists) return false;
      } else {
        if (doc[key] !== expected) return false;
      }
    } else {
      if (doc[key] !== expected) return false;
    }
  }
  return true;
}

describe("services/import", () => {
  test("scan creates a scanning job and broadcasts to the user", async () => {
    const mocks = makeMockJobs();
    const events = [];
    const io = {
      to: (room) => ({
        emit: (event, payload) => events.push({ room, event, payload }),
      }),
    };
    const svc = new ImportService({ importJobs: mocks.collection }, { io });
    const out = await svc.scan("user-1", { folder: "C:\\Replays" });
    expect(out.status).toBe("scanning");
    expect(events[0].event).toBe("import:scan_request");
    expect(mocks.docs[0].kind).toBe("scan");
  });

  test("start rejects when an import is already in progress", async () => {
    const mocks = makeMockJobs();
    const svc = new ImportService({ importJobs: mocks.collection });
    await svc.start("user-1", { folder: "C:\\Replays" });
    await expect(svc.start("user-1", { folder: "C:\\Replays" })).rejects.toThrow(/import_already_running/);
  });

  test("status returns the latest job in serialised form", async () => {
    const mocks = makeMockJobs();
    const svc = new ImportService({ importJobs: mocks.collection });
    await svc.start("user-1", { folder: "C:\\Replays" });
    const status = await svc.status("user-1");
    expect(status.ok).toBe(true);
    expect(status.kind).toBe("import");
  });

  test("validation rejects bogus since_iso", async () => {
    const mocks = makeMockJobs();
    const svc = new ImportService({ importJobs: mocks.collection });
    await expect(
      svc.start("user-1", { folder: "C:\\Replays", since_iso: "yesterday" }),
    ).rejects.toThrow(/since_iso/);
  });

  test("setHostInfo persists cores under host_info doc", async () => {
    const mocks = makeMockJobs();
    const svc = new ImportService({ importJobs: mocks.collection });
    await svc.setHostInfo("user-1", { cores: 12, replayFolders: ["C:\\Replays"] });
    const cores = await svc.cores("user-1");
    expect(cores.cores).toBe(12);
  });

  test("cancel marks the job cancelled and broadcasts a cancel request", async () => {
    const mocks = makeMockJobs();
    const events = [];
    const io = {
      to: () => ({
        emit: (event) => events.push(event),
      }),
    };
    const svc = new ImportService({ importJobs: mocks.collection }, { io });
    await svc.start("user-1", { folder: "C:\\Replays" });
    const out = await svc.cancel("user-1");
    expect(out.cancelled).toBe(1);
    expect(events).toContain("import:cancel_request");
  });
});
