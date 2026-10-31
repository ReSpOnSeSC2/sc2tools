# Device auth: durable disable primitive (October 30 UTC)

The program remains active and incomplete. Faster-dashboards slice DA4 adds the
durable disable that ADR 0072's rollback rule and Gates table require before
device-auth retention may ever be activated
([ADR 0072](../adr/0072-serving-cohort-coherence.md#gates);
`docs/adr/0071-device-credential-readiness.md:59-60`). Until now the source had
no deliberate way to stop grants. API paths are relative to `apps/api/src/`.

`DeviceCredentialWrites.disable({ incarnation })` compare-and-sets the exact
authority incarnation to the non-granting `prepared` mode and, like every other
authority write, rotates the generation. Grants need an `active` record
(`services/deviceAuthAuthority.js:11-17`). The method never sets `active` and
never touches pending work or `denyAll`. After every write it attempts, it waits
out the 2.1-second old-lease bound before it reports, so a grant issued before
the write has expired by the time the operator sees the result. An owner-run
script wraps it. The script is a dry run by default and writes only with the
exact incarnation and `--apply`.

Nothing calls it. No route, endpoint, flag or startup path reaches the method
or the script, the REST adapter stays uninjected (`app.js:350-356`) and
`USER_CACHE_ENABLED` stays off. No migration, provider setting or
infrastructure change is included. DA4 is stacked on DA3
([PR #832](https://github.com/ReSpOnSeSC2/sc2tools/pull/832)) and merges after
it.

## What changed

- `services/deviceCredentialWrites.js:198-220` adds `disable()`, after
  `stopAndDrain()`:
  - a malformed incarnation throws `device_credential_disable_invalid` before
    any write;
  - no matching record, for a mismatched incarnation or a record that fails
    the fail-closed filter, returns `refused` and writes nothing;
  - an unknown write outcome logs a warning, still drains, and returns
    `possibly-disabled`;
  - a written record that fails verification, such as one whose pending list
    holds a malformed entry the filter does not inspect, drains and then throws
    `device_credential_disable_unverified`;
  - success drains, then returns `disabled` with the new generation.

  The write uses the module's majority, journaled write options.
- `apps/api/scripts/disable-device-auth-retention.js` (new) prints the host and
  the database, reads the record at majority, and prints its incarnation, mode,
  `denyAll` and pending count. It passes a logger, so the cause of an unknown
  outcome is printed. Exit codes:
  - 0 for a dry run or a disable;
  - 1 when refused (a mismatched incarnation, or no record to disable) or when
    it fails before any write;
  - 2 for usage, an invalid incarnation included;
  - 3 when the outcome is unknown after the write was attempted.
- The insertion moves `prepareWriterAuthority` from lines 200-204 to 224-228
  (`services/deviceCredentialWrites.js:224-228`), and ADR 0072's two citations
  of it are updated in place.

## Operator use

Run it only for an owner-approved rollback, or before an out-of-band write
while retention could be active. Retention has never been activated, and no
activation CAS exists. Run it with the API's `MONGODB_URI` and `MONGODB_DB`, and
check the printed host and database before you pass `--apply`:

```bash
node scripts/disable-device-auth-retention.js
node scripts/disable-device-auth-retention.js --incarnation <uuid from the dry run> --apply
```

After exit code 3, run the dry run again to read the mode. Only the reviewed
activation CAS may re-enable grants, and it is not built.

## Tests

`apps/api/__tests__/deviceCredentialDisable.mongo.test.js` (new) has six
real-Mongo cases. Every drain in them records the mode it starts on, so a drain
that ran before the write would show the old mode:

- the exact disable: prepared mode, a fresh generation, pending work and
  `denyAll` kept, and one drain that starts after the write
  (`apps/api/__tests__/deviceCredentialDisable.mongo.test.js:35-49`);
- a malformed or mismatched incarnation writes nothing, and repeating a disable
  stays non-granting (`:51-60`);
- after a disable no lease can grant, and a ticket prepared before it cannot be
  consumed (`:62-75`);
- an unknown write outcome reports possibly disabled and still drains
  (`:77-84`);
- a written record that fails verification drains before it throws, and the
  script exits 3 after a real 2.1-second drain (`:86-98`);
- the script names its database, dry-runs by default and maps each outcome to
  its exit code (`:100-116`).

## Verification

Local checks ran at `90126ee2`, DA4's head after the review fixes, with DA3 and
C4 merged in. The receipt is
`docs/handoff/validation/device-auth-disable/local-verification.json`.

- **API.** Whole-API types pass. Configured lint reports 758 warnings and 0
  errors, the same as C4. The changed writer file adds no configured or strict
  message, and the new script and suite pass strict lint.
- **Suites.** The fifteen device-auth suites pass 180 of 180 cases in band, on
  cached MongoDB 7.0.14 with downloads disabled. No MongoDB process was left
  over.
- **Mutation.** 11 of 11 deliberate regressions are killed:
  - setting `active`;
  - keeping the old generation;
  - clearing pending work;
  - removing the drain after the write;
  - skipping the drain after an unknown outcome;
  - ignoring the incarnation;
  - a dry run that writes;
  - throwing on an unverified record before the drain;
  - draining before the write;
  - reporting a post-write failure as refused;
  - succeeding on `--apply` with no record.
- **Review.** One independent read-only reviewer found that an unverified
  written record skipped the drain and was reported as refused. It also noted
  three gaps: the script did not name its database, `--apply` succeeded with no
  record, and the drain order was untested. All four are fixed in `173bb37c`;
  `90126ee2` then splits the script for strict lint.

## Limitations

- It has never run against a real deployment.
- It is not a repair. A raw restore or a manual edit of the authority record can
  rewind its mode, generation or pending list. The authorized repair primitive,
  which mints a fresh incarnation, is still unmet.
- The drain uses this process's clock and ADR 0071's proposed lease constants,
  whose clock-rate and suspension behavior is unverified. A clock failure
  during the drain ends it early and reports exit 3.
- Nothing deliberately sets `denyAll`, so the out-of-band `denyAll` barrier
  still has no setter.

## Remaining dashboard work

G1 (the chart-cache overlap guard), C5 (opponent-collection writers) and R1
(the activation review) remain. ADR 0072's repair, election, clock,
cohort-qualification and activation-CAS gates are still unmet.
