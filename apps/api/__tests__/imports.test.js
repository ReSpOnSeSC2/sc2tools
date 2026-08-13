// @ts-nocheck
"use strict";

const { ImportService } = require("../src/services/import");

function makeMockJobs() {
  /** @type {any[]} */
  const docs = [];
  let nextId = 1;
  const collection = {
    async insertOne(doc) {
      // 24-hex ids so reportProgress's `new ObjectId(jobId)` accepts
      // them; matches() compares stringified, so ObjectId queries hit.
      const _id = String(nextId++).padStart(24, "0");
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
        docs.push({ _id: String(nextId++).padStart(24, "0"), ...(update.$setOnInsert || {}), ...(update.$set || {}) });
      }
      return { matchedCount: idx >= 0 ? 1 : 0, upsertedCount: idx < 0 && opts.upsert ? 1 : 0 };
    },
    async findOneAndUpdate(query, update, _opts = {}) {
      // Mirrors driver 6.x with returnDocument:"after" — returns the
      // post-update doc (or null). Supports the $set/$max mix
      // reportProgress uses.
      const idx = docs.findIndex((d) => matches(d, query));
      if (idx < 0) return null;
      const next = { ...docs[idx], ...(update.$set || {}) };
      for (const [k, v] of Object.entries(update.$max || {})) {
        const cur = typeof next[k] === "number" ? next[k] : -Infinity;
        next[k] = Math.max(cur, v);
      }
      docs[idx] = next;
      return next;
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
        // Non-operator object (e.g. an ObjectId instance): compare
        // stringified so hex ObjectIds match the mock's string _ids.
        if (doc[key] !== expected && String(doc[key]) !== String(expected)) {
          return false;
        }
      }
    } else {
      // Stringified fallback so ObjectId(hex) queries match the
      // mock's plain-string _ids.
      if (doc[key] !== expected && String(doc[key]) !== String(expected)) {
        return false;
      }
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

  test("stalled background work still blocks a second import", async () => {
    const mocks = makeMockJobs();
    const svc = new ImportService({ importJobs: mocks.collection });
    mocks.docs.push({
      _id: "stalled-job",
      userId: "user-1",
      status: "stalled",
      startedAt: new Date(),
    });

    await expect(svc.start("user-1", {})).rejects.toThrow(
      /import_already_running/,
    );
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

  test("cancel also stops a stalled background import", async () => {
    const mocks = makeMockJobs();
    const svc = new ImportService({ importJobs: mocks.collection });
    mocks.docs.push({
      _id: "stalled-job",
      userId: "user-1",
      status: "stalled",
      startedAt: new Date(),
    });

    const out = await svc.cancel("user-1");

    expect(out.cancelled).toBe(1);
    expect(out.jobId).toBe("stalled-job");
    expect(mocks.docs[0].status).toBe("cancelled");
    expect(mocks.docs[0].lastMessage).toBe("cancelled_by_user");
  });

  test("start works without a folder (agent resolves its own roots)", async () => {
    const mocks = makeMockJobs();
    const events = [];
    const io = {
      to: () => ({
        emit: (event, payload) => events.push({ event, payload }),
      }),
    };
    const svc = new ImportService({ importJobs: mocks.collection }, { io });
    const out = await svc.start("user-1", {});
    expect(out.status).toBe("running");
    const startEvent = events.find((e) => e.event === "import:start_request");
    expect(startEvent.payload.folder).toBeNull();
  });

  test("agentStart mints a backfill job and reuses an active one", async () => {
    const mocks = makeMockJobs();
    const events = [];
    const io = {
      to: () => ({
        emit: (event, payload) => events.push({ event, payload }),
      }),
    };
    const svc = new ImportService({ importJobs: mocks.collection }, { io });
    const first = await svc.agentStart("user-1", { total: 412 });
    expect(first.existing).toBe(false);
    expect(mocks.docs[0].kind).toBe("backfill");
    expect(mocks.docs[0].total).toBe(412);
    // The dashboard learns about the new job over the user socket.
    expect(events.some((e) => e.event === "import:progress")).toBe(true);
    // A second registration while the job runs returns the SAME job —
    // the web "Import my history" click and the agent's auto-backfill
    // must not double-mint.
    const second = await svc.agentStart("user-1", { total: 9 });
    expect(second.existing).toBe(true);
    expect(second.jobId).toBe(first.jobId);
  });

  test("reportProgress counters are monotonic; sockets carry the high-water mark", async () => {
    // A restarted agent (auto-update mid-backfill) re-adopts its job
    // and re-reports from a low absolute count until it catches up.
    // Pre-fix the $set write regressed the stored counters and every
    // dashboard saw the progress numbers run backwards and forwards.
    const mocks = makeMockJobs();
    const events = [];
    const io = {
      to: () => ({
        emit: (event, payload) => events.push({ event, payload }),
      }),
    };
    const svc = new ImportService({ importJobs: mocks.collection }, { io });
    const { jobId } = await svc.agentStart("user-1", { total: 100 });
    await svc.reportProgress("user-1", jobId, {
      completed: 60,
      errors: 2,
      total: 100,
      remaining: 38,
    });
    await svc.reportProgress("user-1", jobId, {
      completed: 3,
      errors: 0,
      total: 4,
      remaining: 1,
    });
    const job = mocks.docs.find((d) => String(d._id) === String(jobId));
    expect(job.completed).toBe(60);
    expect(job.errors).toBe(2);
    expect(job.total).toBe(100);
    // The socket event for the low report carries the stored
    // high-water mark, not the stale absolute values.
    const last = events.filter((e) => e.event === "import:progress").pop();
    expect(last.payload.completed).toBe(60);
    expect(last.payload.errors).toBe(2);
    expect(last.payload.total).toBe(100);
    expect(last.payload.remaining).toBe(38);
    expect((await svc.status("user-1")).remaining).toBe(38);
    // Forward movement still flows through.
    await svc.reportProgress("user-1", jobId, { completed: 75 });
    expect(mocks.docs.find((d) => String(d._id) === String(jobId)).completed).toBe(75);
  });

  test("stalled progress stays unfinished, preserves remaining, and can recover", async () => {
    const mocks = makeMockJobs();
    const events = [];
    const io = {
      to: () => ({
        emit: (event, payload) => events.push({ event, payload }),
      }),
    };
    const svc = new ImportService({ importJobs: mocks.collection }, { io });
    const { jobId } = await svc.agentStart("user-1", { total: 100 });

    await svc.reportProgress("user-1", jobId, {
      completed: 20,
      errors: 1,
      remaining: 79,
      phase: "import",
      stalled: true,
      message: "import_stalled_background_continues",
    });
    let status = await svc.status("user-1");
    expect(status).toMatchObject({
      status: "stalled",
      completed: 20,
      errors: 1,
      remaining: 79,
      finishedAt: null,
    });
    expect(status.status).not.toBe("done");
    expect((await svc.activeJob("user-1")).status).toBe("stalled");

    // A restarted agent reattaches to the same unfinished tracker.
    const adopted = await svc.agentStart("user-1", { total: 79 });
    expect(adopted).toMatchObject({
      existing: true,
      jobId,
      status: "stalled",
    });

    // Only the reporter's explicit recovery flag restores running; a
    // generic late progress packet cannot resurrect terminal jobs.
    await svc.reportProgress("user-1", jobId, {
      completed: 21,
      remaining: 78,
      phase: "import",
      stalled: false,
      message: "import_progress_resumed",
    });
    status = await svc.status("user-1");
    expect(status).toMatchObject({
      status: "running",
      completed: 21,
      remaining: 78,
      finishedAt: null,
    });

    const last = events.filter((e) => e.event === "import:progress").pop();
    expect(last.payload).toMatchObject({
      status: "running",
      completed: 21,
      remaining: 78,
    });

    // Completion is the only state that forces remaining to zero.
    await svc.reportProgress("user-1", jobId, {
      completed: 21,
      remaining: 78,
      done: true,
    });
    status = await svc.status("user-1");
    expect(status.status).toBe("done");
    expect(status.remaining).toBe(0);
  });

  test("legacy agents' stalled done packet is not treated as complete", async () => {
    const mocks = makeMockJobs();
    const svc = new ImportService({ importJobs: mocks.collection });
    const { jobId } = await svc.agentStart("user-1", { total: 100 });

    await svc.reportProgress("user-1", jobId, {
      total: 100,
      completed: 20,
      errors: 1,
      done: true,
      message: "import_stalled_card_closed",
    });

    expect(await svc.status("user-1")).toMatchObject({
      status: "stalled",
      completed: 20,
      errors: 1,
      remaining: 79,
      finishedAt: null,
    });
  });

  test("late stall/recovery/completion packets cannot revive a cancelled job", async () => {
    const mocks = makeMockJobs();
    const events = [];
    const io = {
      to: () => ({
        emit: (event, payload) => events.push({ event, payload }),
      }),
    };
    const svc = new ImportService({ importJobs: mocks.collection }, { io });
    const { jobId } = await svc.agentStart("user-1", { total: 10 });
    await svc.cancel("user-1");
    const eventCountAfterCancel = events.length;

    for (const payload of [
      { completed: 1, remaining: 9 },
      { stalled: true, remaining: 10 },
      { stalled: false, completed: 1, remaining: 9 },
      { done: true, completed: 10, remaining: 0 },
    ]) {
      const out = await svc.reportProgress("user-1", jobId, payload);
      expect(out).toMatchObject({ ok: true, ignored: true });
    }

    const status = await svc.status("user-1");
    expect(status.status).toBe("cancelled");
    expect(status.finishedAt).not.toBeNull();
    // Rejected transitions do not leak misleading socket updates.
    expect(events).toHaveLength(eventCountAfterCancel);
  });

  test("agentStart reuse returns the job's prior counters for seeding", async () => {
    const mocks = makeMockJobs();
    const svc = new ImportService({ importJobs: mocks.collection });
    const first = await svc.agentStart("user-1", { total: 412 });
    await svc.reportProgress("user-1", first.jobId, { completed: 50, errors: 4 });
    const second = await svc.agentStart("user-1", { total: 9 });
    expect(second.existing).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    expect(second.completed).toBe(50);
    expect(second.errors).toBe(4);
    expect(second.total).toBe(412);
  });

  test("activeJob returns the running job serialised, null when idle", async () => {
    const mocks = makeMockJobs();
    const svc = new ImportService({ importJobs: mocks.collection });
    expect(await svc.activeJob("user-1")).toBeNull();
    await svc.start("user-1", {});
    const active = await svc.activeJob("user-1");
    expect(active.status).toBe("running");
    expect(typeof active.jobId).toBe("string");
  });
});
