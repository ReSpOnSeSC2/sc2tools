#!/usr/bin/env node
"use strict";

/**
 * Re-link an existing internal user to a NEW Clerk user id.
 *
 * Why this exists: when the Clerk instance moved from development to
 * production (June 2026), every account had to be re-created on the
 * production instance, which issues brand-new Clerk user ids. All app
 * data (games, builds, dossiers, device pairings) hangs off our
 * internal UUID, and only the `users` doc maps Clerk id -> UUID — so
 * "migrating" an account is a single field swap on the OLD user doc,
 * plus parking the empty placeholder doc the first production sign-in
 * created. The paired desktop agent keeps working untouched.
 *
 * Usage (run with the API's env: MONGODB_URI + MONGODB_DB):
 *   node scripts/relink-clerk-user.js --list
 *   node scripts/relink-clerk-user.js --old user_2abc... --new user_2xyz...
 *   node scripts/relink-clerk-user.js --old user_2abc... --new user_2xyz... --apply
 *
 * Without --apply it's a dry run: prints what would change, writes
 * nothing. --list prints every user with game/build counts so the old
 * and new ids are easy to tell apart.
 */

const { MongoClient } = require("mongodb");

const URI = process.env.MONGODB_URI;
const DB = process.env.MONGODB_DB || "sc2tools_saas";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}
const LIST = process.argv.includes("--list");
const APPLY = process.argv.includes("--apply");
const OLD_CLERK = arg("--old");
const NEW_CLERK = arg("--new");

async function main() {
  if (!URI) {
    console.error("MONGODB_URI is not set. Run with the API's environment.");
    process.exit(1);
  }
  if (!LIST && (!OLD_CLERK || !NEW_CLERK)) {
    console.error(
      "Usage: --list  OR  --old <oldClerkId> --new <newClerkId> [--apply]",
    );
    process.exit(1);
  }
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB);
  try {
    if (LIST) {
      await listUsers(db);
      return;
    }
    await relink(db);
  } finally {
    await client.close();
  }
}

async function listUsers(db) {
  const users = await db.collection("users").find({}).toArray();
  for (const u of users) {
    const [games, builds, pairings] = await Promise.all([
      db.collection("games").countDocuments({ userId: u.userId }),
      db.collection("custom_builds").countDocuments({ userId: u.userId }),
      db.collection("device_tokens").countDocuments({ userId: u.userId }),
    ]);
    console.log(
      [
        `clerk=${u.clerkUserId}`,
        `internal=${u.userId}`,
        `created=${u.createdAt?.toISOString?.() ?? u.createdAt}`,
        `lastSeen=${u.lastSeenAt?.toISOString?.() ?? u.lastSeenAt}`,
        `games=${games}`,
        `builds=${builds}`,
        `agentTokens=${pairings}`,
      ].join("  "),
    );
  }
  console.log(`\n${users.length} user(s).`);
}

async function relink(db) {
  const users = db.collection("users");
  const oldDoc = await users.findOne({ clerkUserId: OLD_CLERK });
  const newDoc = await users.findOne({ clerkUserId: NEW_CLERK });
  if (!oldDoc) throw new Error(`no user with clerkUserId=${OLD_CLERK}`);
  if (!newDoc) {
    throw new Error(
      `no user with clerkUserId=${NEW_CLERK} — sign in once on production first`,
    );
  }
  if (oldDoc.userId === newDoc.userId) {
    console.log("Old and new Clerk ids already point at the same user. Nothing to do.");
    return;
  }
  const newGames = await db
    .collection("games")
    .countDocuments({ userId: newDoc.userId });
  if (newGames > 0) {
    throw new Error(
      `safety stop: the NEW user already owns ${newGames} game(s); ` +
        "merge those manually before re-linking",
    );
  }
  const oldGames = await db
    .collection("games")
    .countDocuments({ userId: oldDoc.userId });
  console.log(
    `${APPLY ? "APPLYING" : "DRY RUN"}: re-link internal user ${oldDoc.userId}` +
      ` (${oldGames} games) from ${OLD_CLERK} -> ${NEW_CLERK}`,
  );
  console.log(
    `placeholder user ${newDoc.userId} (0 games) will be parked as clerkUserId=` +
      `migrated:${NEW_CLERK}`,
  );
  if (!APPLY) {
    console.log("\nDry run only — re-run with --apply to write.");
    return;
  }
  // Free the unique clerkUserId index first, then swap. Keeping the
  // placeholder doc (parked) preserves an audit trail of the merge.
  await users.updateOne(
    { _id: newDoc._id },
    {
      $set: {
        clerkUserId: `migrated:${NEW_CLERK}`,
        migratedToUserId: oldDoc.userId,
        migratedAt: new Date(),
      },
    },
  );
  await users.updateOne(
    { _id: oldDoc._id },
    {
      $set: {
        clerkUserId: NEW_CLERK,
        previousClerkUserId: OLD_CLERK,
        relinkedAt: new Date(),
      },
    },
  );
  console.log("Done. Sign out and back in on the site; data and the paired agent follow.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
