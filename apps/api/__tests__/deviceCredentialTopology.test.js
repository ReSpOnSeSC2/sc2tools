"use strict";

const { credentialReadinessCapability } = require("../src/services/deviceCredentialTopology");
const known = { ok: 1, maxWireVersion: 21, isWritablePrimary: true, logicalSessionTimeoutMinutes: 30 };
test("positive standalone hello is writer-only, independently of the game-statistics capability", () => {
  expect(credentialReadinessCapability(known)).toBe("writer-only-standalone");
  expect(credentialReadinessCapability({ ...known, setName: "one" })).toBe("causal");
  expect(credentialReadinessCapability({ ...known, msg: "isdbgrid" })).toBe("causal");
});
test.each([null, {}, { ...known, ok: 0 }, { ...known, maxWireVersion: NaN },
  { ...known, isWritablePrimary: false }, { ...known, isreplicaset: true }, { ...known, hosts: [] },
  { ...known, hosts: null }, { ...known, hosts: "unknown" }, { ...known, isreplicaset: null },
  { ...known, setName: null }, { ...known, msg: "unknown" }, { ...known, setName: "one", logicalSessionTimeoutMinutes: undefined },
  { ...known, setName: "one", logicalSessionTimeoutMinutes: 0 }, { ...known, setName: "one", logicalSessionTimeoutMinutes: -1 },
  { ...known, msg: "isdbgrid", logicalSessionTimeoutMinutes: 0.5 }])(
  "unknown/unsupported hello %j cannot select standalone or retained capability", hello => {
    expect(credentialReadinessCapability(hello)).toBe("unavailable");
  },
);
