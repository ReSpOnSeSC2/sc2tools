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
never touches pending work or `denyAll`. It then waits out the 2.1-second
old-lease bound before it reports, so a grant issued before the write has
expired by the time the operator sees the result. An owner-run script wraps it.
The script is a dry run by default and writes only with the exact incarnation
and `--apply`.

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
  - a returned row that is not a valid prepared record throws
    `device_credential_disable_unverified`;
  - an unknown write outcome logs a warning, still drains, and returns
    `possibly-disabled`;
  - success drains, then returns `disabled` with the new generation.

  The write uses the module's majority, journaled write options.
- `apps/api/scripts/disable-device-auth-retention.js` (new) reads the record at
  majority and prints its incarnation, mode, `denyAll` and pending count. Its
  exit codes are 0 for a dry run or a disable, 1 for refused, 2 for usage and 3
  for possibly disabled.
- The insertion moves `prepareWriterAuthority` from lines 200-204 to 224-228
  (`services/deviceCredentialWrites.js:224-228`), and ADR 0072's two citations
  of it are updated in place.

## Operator use

Run it only for an owner-approved rollback, or before an out-of-band write
while retention could be active. Retention has never been activated, and no
activation CAS exists. Run it with the API's `MONGODB_URI` and `MONGODB_DB`:

```bash
node scripts/disable-device-auth-retention.js
node scripts/disable-device-auth-retention.js --incarnation <uuid from the dry run> --apply
```

After exit code 3, run the dry run again to read the mode. Only the reviewed
activation CAS may re-enable grants, and it is not built.

## Tests

`apps/api/__tests__/deviceCredentialDisable.mongo.test.js` (new) has five
real-Mongo cases:

- the exact disable: prepared mode, a fresh generation, pending work and
  `denyAll` kept, and the drain before the method reports
  (`apps/api/__tests__/deviceCredentialDisable.mongo.test.js:34-49`);
- a malformed or mismatched incarnation writes nothing, and repeating a disable
  stays non-granting (`:50-60`);
- after a disable no lease can grant, and a ticket prepared before it cannot be
  consumed (`:61-75`);
- an unknown write outcome reports possibly disabled and still drains
  (`:76-84`);
- the script dry-runs by default and writes only with the exact incarnation
  and `--apply` (`:85-98`).

## Verification

Local checks ran at `7f4c433e`, DA4 with DA3 merged in. Mutations ran at
`eca91b56`, DA4's own commit; the only later application change is C4's
one-line comment. The receipt is
`docs/handoff/validation/device-auth-disable/local-verification.json`.

- **API.** Whole-API types pass. Configured lint reports 758 warnings and 0
  errors, the same as C4. The changed writer file adds no configured or strict
  message, and the new script and suite pass strict lint.
- **Suites.** The fifteen device-auth suites pass 179 of 179 cases in band, on
  cached MongoDB 7.0.14 with downloads disabled. No MongoDB process was left
  over.
- **Mutation.** 7 of 7 deliberate regressions are killed:
  - setting `active`;
  - keeping the old generation;
  - clearing pending work;
  - skipping the drain after a success;
  - skipping the drain after an unknown outcome;
  - ignoring the incarnation;
  - a dry run that writes.

## Limitations

- It has never run against a real deployment.
- It is not a repair. A raw restore or a manual edit of the authority record can
  rewind its mode, generation or pending list. The authorized repair primitive,
  which mints a fresh incarnation, is still unmet.
- The drain uses this process's clock and ADR 0071's proposed lease constants,
  whose clock-rate and suspension behavior is unverified.
- Nothing deliberately sets `denyAll`, so the out-of-band `denyAll` barrier
  still has no setter.

## Remaining dashboard work

G1 (the chart-cache overlap guard), C5 (opponent-collection writers) and R1
(the activation review) remain. ADR 0072's repair, election, clock,
cohort-qualification and activation-CAS gates are still unmet.
