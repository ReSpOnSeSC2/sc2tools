"use strict";

const {
  REGISTRY,
  VERSION_KEY,
  SchemaTooNewError,
  registerMigration,
  expectedVersion,
  stampVersion,
  getOnDiskVersion,
  migrateDoc,
  assertNotTooNew,
  _internals,
} = require("../../src/db/schemaVersioning");
const { COLLECTIONS } = require("../../src/config/constants");

describe("db/schemaVersioning", () => {
  // The test collection we register migrations against. We re-use a real
  // collection name from the registry; tests reset the migration list at
  // the end to avoid leaking into the rest of the suite.
  const TEST = COLLECTIONS.OPPONENTS;
  const original = _internals.MIGRATIONS.slice();

  afterEach(() => {
    _internals.MIGRATIONS.length = 0;
    _internals.MIGRATIONS.push(...original);
  });

  test("REGISTRY covers every COLLECTIONS entry", () => {
    for (const name of Object.values(COLLECTIONS)) {
      expect(REGISTRY[name]).toBeTruthy();
      expect(REGISTRY[name].currentVersion).toBeGreaterThanOrEqual(1);
    }
  });

  test("stampVersion writes _schemaVersion in place", () => {
    const doc = { foo: "bar" };
    stampVersion(doc, TEST);
    expect(doc[VERSION_KEY]).toBe(expectedVersion(TEST));
    expect(doc.foo).toBe("bar");
  });

  test("stampVersion is a no-op for unknown collections", () => {
    const doc = { foo: "bar" };
    stampVersion(doc, "not_a_collection");
    expect(doc[VERSION_KEY]).toBeUndefined();
  });

  test("stampVersion ignores arrays and primitives", () => {
    expect(stampVersion(null, TEST)).toBe(null);
    expect(stampVersion([1, 2], TEST)).toEqual([1, 2]);
    expect(stampVersion("x", TEST)).toBe("x");
  });

  test("getOnDiskVersion reads stamped version", () => {
    const doc = { foo: 1 };
    expect(getOnDiskVersion(doc, TEST)).toBe(null);
    stampVersion(doc, TEST);
    expect(getOnDiskVersion(doc, TEST)).toBe(1);
  });

  test("migrateDoc applies forward migration", () => {
    registerMigration({
      collection: TEST,
      fromVersion: 1,
      toVersion: 2,
      forward: (d) => ({ ...d, addedField: "yes" }),
      backward: (d) => {
        const { addedField, ...rest } = d;
        return rest;
      },
    });
    const doc = { foo: "bar", [VERSION_KEY]: 1 };
    const migrated = migrateDoc(doc, TEST, { targetVersion: 2 });
    expect(migrated.addedField).toBe("yes");
    expect(migrated[VERSION_KEY]).toBe(2);
  });

  test("migrateDoc applies backward migration", () => {
    registerMigration({
      collection: TEST,
      fromVersion: 1,
      toVersion: 2,
      forward: (d) => ({ ...d, addedField: "yes" }),
      backward: (d) => {
        const { addedField, ...rest } = d;
        return rest;
      },
    });
    const doc = { foo: "bar", addedField: "yes", [VERSION_KEY]: 2 };
    const migrated = migrateDoc(doc, TEST, { targetVersion: 1 });
    expect(migrated.addedField).toBeUndefined();
    expect(migrated[VERSION_KEY]).toBe(1);
  });

  test("migrateDoc chains multiple forward steps", () => {
    registerMigration({
      collection: TEST,
      fromVersion: 1,
      toVersion: 2,
      forward: (d) => ({ ...d, step1: true }),
      backward: (d) => {
        const { step1, ...rest } = d;
        return rest;
      },
    });
    registerMigration({
      collection: TEST,
      fromVersion: 2,
      toVersion: 3,
      forward: (d) => ({ ...d, step2: true }),
      backward: (d) => {
        const { step2, ...rest } = d;
        return rest;
      },
    });
    const doc = { [VERSION_KEY]: 1 };
    const migrated = migrateDoc(doc, TEST, { targetVersion: 3 });
    expect(migrated.step1).toBe(true);
    expect(migrated.step2).toBe(true);
    expect(migrated[VERSION_KEY]).toBe(3);
  });

  test("migrateDoc throws when a forward step is missing", () => {
    const doc = { [VERSION_KEY]: 1 };
    expect(() => migrateDoc(doc, TEST, { targetVersion: 2 })).toThrow(
      /missing forward migration/,
    );
  });

  test("migrateDoc treats unstamped docs as v1", () => {
    registerMigration({
      collection: TEST,
      fromVersion: 1,
      toVersion: 2,
      forward: (d) => ({ ...d, ran: true }),
      backward: (d) => {
        const { ran, ...rest } = d;
        return rest;
      },
    });
    const doc = { hello: "world" };
    const migrated = migrateDoc(doc, TEST, { targetVersion: 2 });
    expect(migrated.ran).toBe(true);
    expect(migrated[VERSION_KEY]).toBe(2);
  });

  test("assertNotTooNew throws when on-disk version exceeds writer version", () => {
    const doc = { [VERSION_KEY]: 999 };
    expect(() => assertNotTooNew(doc, TEST)).toThrow(SchemaTooNewError);
  });

  test("assertNotTooNew is silent for unstamped docs", () => {
    expect(() => assertNotTooNew({}, TEST)).not.toThrow();
  });

  test("registerMigration validates shape", () => {
    expect(() =>
      registerMigration({
        collection: TEST,
        fromVersion: 1,
        toVersion: 2,
      }),
    ).toThrow(/malformed/);
  });

  test("registerMigration rejects unknown collection", () => {
    expect(() =>
      registerMigration({
        collection: "not_real",
        fromVersion: 1,
        toVersion: 2,
        forward: (d) => d,
        backward: (d) => d,
      }),
    ).toThrow(/unknown collection/);
  });
});
