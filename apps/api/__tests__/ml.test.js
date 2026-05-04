// @ts-nocheck
"use strict";

const { MLService } = require("../src/services/ml");

function makeMongo({ models = [], jobs = [] } = {}) {
  let nextJobId = 1;
  const mlModels = {
    async findOne(query, opts = {}) {
      const found = models.find(
        (m) => m.userId === query.userId && m.kind === query.kind,
      );
      if (!found) return null;
      if (opts && opts.projection && opts.projection.blob === 0) {
        const { blob: _b, ...rest } = found;
        return rest;
      }
      return found;
    },
    async updateOne(query, update, opts) {
      const idx = models.findIndex(
        (m) => m.userId === query.userId && m.kind === query.kind,
      );
      const setDoc = update.$set || {};
      if (idx >= 0) {
        models[idx] = { ...models[idx], ...setDoc };
      } else if (opts && opts.upsert) {
        models.push({ ...setDoc, ...(update.$setOnInsert || {}) });
      }
    },
  };
  const mlJobs = {
    async insertOne(doc) {
      const _id = String(nextJobId++);
      jobs.push({ _id, ...doc });
      return { insertedId: _id };
    },
    async findOne(query, opts = {}) {
      const sortKey = opts.sort ? Object.keys(opts.sort)[0] : null;
      let candidates = jobs.filter((j) => match(j, query));
      if (sortKey) {
        candidates = candidates.slice().sort((a, b) => {
          const av = a[sortKey];
          const bv = b[sortKey];
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * opts.sort[sortKey];
        });
      }
      return candidates[0] || null;
    },
    async updateOne(query, update) {
      const idx = jobs.findIndex((j) => match(j, query));
      if (idx >= 0) jobs[idx] = { ...jobs[idx], ...(update.$set || {}) };
    },
  };
  const games = {
    find() {
      return {
        sort: () => ({
          limit: () => ({
            [Symbol.asyncIterator]: async function* () {},
          }),
        }),
      };
    },
  };
  return { mlModels, mlJobs, games };
}

function match(doc, query) {
  for (const key of Object.keys(query)) {
    if (key === "_id" && doc._id !== String(query._id)) {
      // Allow ObjectId-ish shapes.
      try {
        if (doc._id !== String(query._id)) return false;
      } catch (_e) {
        return false;
      }
    } else if (typeof query[key] !== "object" && doc[key] !== query[key]) {
      return false;
    }
  }
  return true;
}

describe("services/ml", () => {
  test("status returns hasModel=false for an untrained user", async () => {
    const db = makeMongo();
    const svc = new MLService(db);
    const out = /** @type {any} */ (await svc.status("u1"));
    expect(out.hasModel).toBe(false);
    expect(out.model).toBeNull();
  });

  test("status reflects an existing model", async () => {
    const db = makeMongo({
      models: [
        {
          userId: "u1",
          kind: "opener_predict",
          metadata: {
            trainedAt: new Date("2026-04-01"),
            gamesUsed: 100,
            races: ["P", "T", "Z"],
            openings: ["Stargate", "Twilight"],
            trainingMetrics: { accuracy: 0.83 },
          },
        },
      ],
    });
    const svc = new MLService(db);
    const out = /** @type {any} */ (await svc.status("u1"));
    expect(out.hasModel).toBe(true);
    expect(out.model.gamesUsed).toBe(100);
    expect(out.model.openings).toEqual(["Stargate", "Twilight"]);
  });

  test("options returns races + openings or empty arrays", async () => {
    const db = makeMongo();
    const svc = new MLService(db);
    const out = /** @type {any} */ (await svc.options("u1"));
    expect(out.races).toEqual([]);
    expect(out.openings).toEqual([]);
  });

  test("predict throws 503 when python is unavailable", async () => {
    const db = makeMongo();
    const svc = new MLService(db);
    const original = process.env.SC2_PY_ANALYZER_DIR;
    process.env.SC2_PY_ANALYZER_DIR = "/tmp/__definitely_missing__";
    try {
      await expect(
        svc.predict("u1", { myRace: "P", oppRace: "Z" }),
      ).rejects.toThrow(/python_unavailable/);
    } finally {
      if (original === undefined) delete process.env.SC2_PY_ANALYZER_DIR;
      else process.env.SC2_PY_ANALYZER_DIR = original;
    }
  });

  test("train throws 503 when python is unavailable", async () => {
    const db = makeMongo();
    const svc = new MLService(db);
    const original = process.env.SC2_PY_ANALYZER_DIR;
    process.env.SC2_PY_ANALYZER_DIR = "/tmp/__definitely_missing__";
    try {
      await expect(svc.train("u1")).rejects.toThrow(/python_unavailable/);
    } finally {
      if (original === undefined) delete process.env.SC2_PY_ANALYZER_DIR;
      else process.env.SC2_PY_ANALYZER_DIR = original;
    }
  });
});
