// @ts-nocheck
"use strict";
const { ScoutingForecastService } = require("../src/services/scoutingForecast");
const context = { myRace: "P", oppRace: "Z" };
const row = { myRace: "Protoss", myMmr: 4200, opponent: { race: "Zerg", strategy: "Hatch First" }, durationSec: 300, date: new Date("2026-10-25") };
const document = { matchup: "ZvP", n: 60, bandLabel: "4000–4499", openers: [{ build: "Hatch First", frequency: 1 }] };

test("eligible replay rating only: hidden/deleted/pending/resumed/too-short rows cannot select the prior band", async () => {
  const lookup = jest.fn(async () => document), service = new ScoutingForecastService({ lookup });
  const hidden = [{ excluded: true }, { _deleted: true }, { _deletionPending: true }, { isResumedFromReplay: true }, { durationSec: 20 }].map(flags => ({ ...row, myMmr: 7000, ...flags }));
  await service.forecast([...hidden, row], { ...context, myMmr: 0 });
  expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ band: 4000, matchup: "ZvP" }));
});

test("identical public bands join one lookup; no-owner-rating and missing priors fall back without aggregates", async () => {
  let finish;
  const lookup = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  const service = new ScoutingForecastService({ lookup });
  const first = service.forecast([row], context), second = service.forecast([row], context);
  expect(lookup).toHaveBeenCalledTimes(1); finish(document);
  expect(await second).toEqual(await first);
  await service.forecast([row], context); expect(lookup).toHaveBeenCalledTimes(1);
  await service.forecast([{ ...row, myMmr: null }], context); expect(lookup).toHaveBeenCalledTimes(1);
});

test("failed or below-floor derived tables never raise confidence or invent an opening", async () => {
  const lookup = jest.fn().mockRejectedValue(new Error("synthetic missing"));
  expect((await new ScoutingForecastService({ lookup }).forecast([row], context)).prior).toBeNull();
  const low = new ScoutingForecastService({ lookup: jest.fn(async () => ({ ...document, n: 49 })) });
  const result = await low.forecast([], { ...context, myMmr: 4200 });
  expect(result.top).toEqual([]); expect(result.confidence).toBe("Low");
});
