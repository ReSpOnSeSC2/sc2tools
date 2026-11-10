"use strict";

const { observeJob } = require("../util/jobLedger");

/**
 * Delivery work on the existing in-process timers (the reviewDigestJob and
 * identityDeletionJob pattern: setInterval, single-flight, job ledger). No
 * scheduler, cron service or queue infrastructure is added. Every unit of
 * work is idempotent on its own — conditional claims, unique keys and
 * notification delivery keys — so a deploy restart or a brief overlap of
 * two instances cannot double-send.
 *
 *   reports            hourly   close idle streams, then due weekly reports
 *   discord-outbox     30 s     drain queued Discord posts; session summaries every 5 min
 *   coaching-reminders 5 min    24-hour and 1-hour session reminders
 */

/**
 * Deploy restarts reset timers, so the first run comes ``firstDelayMs``
 * after boot (well before a full interval) instead of only at the first
 * interval tick.
 *
 * @param {{name: string, intervalMs: number, firstDelayMs: number, run: () => Promise<unknown>,
 *   logger: import('pino').Logger, jobLedger?: import('../util/jobLedger').JobLedger, enabled?: boolean}} spec
 */
function intervalJob(spec) {
  const logger = spec.logger.child({ component: spec.name });
  const disabled = spec.enabled === false;
  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  /** @type {NodeJS.Timeout|null} */
  let first = null;
  /** @type {Promise<void>|null} */
  let active = null;
  const tick = observeJob(spec, spec.name, spec.intervalMs, spec.run, { disabled, envFlag: "always enabled", firstDelayMs: spec.firstDelayMs });
  const runOnce = () => {
    if (active) return active;
    active = Promise.resolve(tick()).then(() => {}).catch((err) => {
      logger.warn({ code: typeof err?.code === "string" ? err.code : "job_failed" }, `${spec.name}_failed`);
    }).finally(() => { active = null; });
    return active;
  };
  return {
    start() {
      if (timer || disabled) return;
      first = setTimeout(() => void runOnce(), spec.firstDelayMs);
      first.unref?.();
      timer = setInterval(() => void runOnce(), spec.intervalMs);
      timer.unref?.();
      logger.info({ intervalMs: spec.intervalMs }, `${spec.name}_job_started`);
    },
    async stop() {
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      first = null; timer = null;
      await active;
    },
    runOnce,
  };
}

/**
 * @param {{weekly: {sweep: () => Promise<unknown>}, streams: {closeIdle: () => Promise<unknown>},
 *   logger: import('pino').Logger, jobLedger?: import('../util/jobLedger').JobLedger}} deps
 */
function buildReportsJob(deps) {
  return intervalJob({ ...deps, name: "reports", intervalMs: 60 * 60 * 1000, firstDelayMs: 5 * 60 * 1000, run: async () => {
    const streams = /** @type {{closed?: number}} */ (await deps.streams.closeIdle());
    const weekly = /** @type {{sent?: number, built?: number}} */ (await deps.weekly.sweep());
    return { closed: streams?.closed || 0, sent: weekly?.sent || 0, built: weekly?.built || 0 };
  } });
}

/**
 * @param {{discord: {available: boolean, drain: () => Promise<unknown>, sweepSessions: () => Promise<unknown>},
 *   logger: import('pino').Logger, jobLedger?: import('../util/jobLedger').JobLedger}} deps
 */
function buildDiscordOutboxJob(deps) {
  let ticks = 0;
  return intervalJob({ ...deps, name: "discord-outbox", intervalMs: 30 * 1000, firstDelayMs: 30 * 1000, enabled: deps.discord.available, run: async () => {
    ticks += 1;
    if (ticks % 10 === 1) await deps.discord.sweepSessions();
    return deps.discord.drain();
  } });
}

/**
 * @param {{reminders: {sweep: () => Promise<unknown>}, logger: import('pino').Logger, jobLedger?: import('../util/jobLedger').JobLedger}} deps
 */
function buildCoachingReminderJob(deps) {
  return intervalJob({ ...deps, name: "coaching-reminders", intervalMs: 5 * 60 * 1000, firstDelayMs: 60 * 1000, run: () => deps.reminders.sweep() });
}

/**
 * Start all three from server.js. Discord's drain stays off without webhook
 * storage; Web Push needs no timer because it rides each bell write.
 * @param {{jobLedger?: import('../util/jobLedger').JobLedger, weeklyReports: any, streamReports: any, discordWebhooks: any,
 *   coachingReminders: any, pushNotifications: {enabled: boolean}}} services
 * @param {import('pino').Logger} logger
 */
function startDeliveryJobs(services, logger) {
  const jobLedger = services.jobLedger;
  const jobs = [
    buildReportsJob({ jobLedger, weekly: services.weeklyReports, streams: services.streamReports, logger }),
    buildDiscordOutboxJob({ jobLedger, discord: services.discordWebhooks, logger }),
    buildCoachingReminderJob({ jobLedger, reminders: services.coachingReminders, logger }),
  ];
  for (const job of jobs) job.start();
  logger.info({ webPush: services.pushNotifications.enabled ? "enabled" : "disabled",
    discord: services.discordWebhooks.available ? "enabled" : "disabled" }, "delivery_channels_state");
  return { async stop() { for (const job of jobs) await job.stop(); } };
}

module.exports = { buildReportsJob, buildDiscordOutboxJob, buildCoachingReminderJob, intervalJob, startDeliveryJobs };
