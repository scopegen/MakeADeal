import type { Prisma } from "@prisma/client";
import prisma from "../db.server";

// Enforces the privacy policy's retention promises. Runs about hourly inside
// the app process and does three things:
//
// 1. Marks negotiations whose 30 days are up as EXPIRED, if they were still
//    ACTIVE. Nothing ever moved them out of ACTIVE before, so abandoned
//    negotiations showed as active forever.
// 2. Removes what identifies a shopper from negotiations whose 30 days are up:
//    the Shopify customer id and the random browser id. This is the personal
//    data Shopify's protected customer data rules say must not be kept longer
//    than needed. The record itself stays (store, product, prices, outcome,
//    dates, and the reference to the draft order), so per-store history and
//    stats survive. Offers stay too: they hold prices and the bot's own
//    wording, nothing about the shopper.
// 3. Deletes rate-limit rows older than an hour. Each row is keyed by a
//    shopper's real IP address and is useless once its 10 minute window has
//    passed, but nothing ever deleted them.
//
// Never touched: Shopify draft orders and orders, merchant rules, the shop
// record. Deleting a whole shop's data on uninstall is the shop/redact
// webhook's job, not this one.
//
// Everything is done in small batches so a large backlog (the first run
// covers everything older than 30 days) never becomes one huge statement.
// Logs only ever contain counts, never ids, IPs, or any shopper data.
//
// A negotiation's 30 days is NegotiationSession.expiresAt, set at creation
// (see proxy.start.tsx). A session past it can't be continued anyway (see
// proxy.offer.tsx), so nothing live is ever affected.

const RUN_EVERY_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;
// A rate-limit window is 10 minutes. An hour is far past any window in use.
const RATE_LIMIT_KEEP_MS = 60 * 60 * 1000;
const SESSION_BATCH_SIZE = 1000;
const RATE_LIMIT_BATCH_SIZE = 2000;
// Cap per run, so a huge backlog is worked through over several runs.
const MAX_BATCHES_PER_RUN = 20;

// DRY RUN: when true, this only COUNTS what it would change and changes
// nothing. Ships as true on purpose. Watch the container logs for a day, and
// once the counts look right, flip this to false and redeploy. Take a manual
// RDS snapshot first: the first live run cleans the whole backlog at once
// and it can't be undone.
const DRY_RUN = true;

export type RetentionOptions = {
  // Overrides DRY_RUN. Mainly for tests.
  dryRun?: boolean;
  // Treat this as the current time. Mainly for tests.
  now?: Date;
  // Overrides the session batch size. Mainly for tests.
  batchSize?: number;
};

export type RetentionResult = {
  sessionsMarkedExpired: number;
  sessionsScrubbed: number;
  rateLimitRowsDeleted: number;
};

// Updates matching sessions a batch at a time. The filter is re-evaluated on
// every pass and updated rows stop matching it, so this ends by itself once
// everything is done (MAX_BATCHES_PER_RUN is only a backstop). In a dry run
// it just counts.
async function updateSessionsInBatches(
  where: Prisma.NegotiationSessionWhereInput,
  data: Prisma.NegotiationSessionUpdateManyMutationInput,
  dryRun: boolean,
  batchSize: number,
): Promise<number> {
  if (dryRun) return prisma.negotiationSession.count({ where });

  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const rows = await prisma.negotiationSession.findMany({
      where,
      select: { id: true },
      take: batchSize,
    });
    if (rows.length === 0) break;
    const { count } = await prisma.negotiationSession.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data,
    });
    total += count;
    if (rows.length < batchSize) break;
  }
  return total;
}

async function deleteOldRateLimitRows(
  cutoff: Date,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) {
    return prisma.rateLimitBucket.count({
      where: { windowStart: { lt: cutoff } },
    });
  }

  // Deliberately uses Prisma's typed date filter, not raw SQL with a date
  // parameter: a raw comparison depends on the database session's time zone,
  // and a test against a non-UTC database deleted rows that were still
  // within the last hour. The typed filter handles the conversion the same
  // way the dry-run count above does.
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const rows = await prisma.rateLimitBucket.findMany({
      where: { windowStart: { lt: cutoff } },
      select: { id: true },
      take: RATE_LIMIT_BATCH_SIZE,
    });
    if (rows.length === 0) break;
    const { count } = await prisma.rateLimitBucket.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    total += count;
    if (rows.length < RATE_LIMIT_BATCH_SIZE) break;
  }
  return total;
}

export async function runDataRetention(
  options: RetentionOptions = {},
): Promise<RetentionResult> {
  const dryRun = options.dryRun ?? DRY_RUN;
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? SESSION_BATCH_SIZE;

  const sessionsMarkedExpired = await updateSessionsInBatches(
    { status: "ACTIVE", expiresAt: { lt: now } },
    { status: "EXPIRED" },
    dryRun,
    batchSize,
  );

  const sessionsScrubbed = await updateSessionsInBatches(
    {
      expiresAt: { lt: now },
      OR: [{ customerId: { not: null } }, { anonymousId: { not: null } }],
    },
    { customerId: null, anonymousId: null },
    dryRun,
    batchSize,
  );

  const rateLimitRowsDeleted = await deleteOldRateLimitRows(
    new Date(now.getTime() - RATE_LIMIT_KEEP_MS),
    dryRun,
  );

  return { sessionsMarkedExpired, sessionsScrubbed, rateLimitRowsDeleted };
}

let running = false;

async function runScheduled(): Promise<void> {
  // A slow run must never overlap with the next scheduled one.
  if (running) return;
  running = true;
  try {
    const result = await runDataRetention();
    // Only log when there was something to do, so an idle hour adds nothing
    // to the container logs.
    if (
      result.sessionsMarkedExpired > 0 ||
      result.sessionsScrubbed > 0 ||
      result.rateLimitRowsDeleted > 0
    ) {
      console.log(
        `[data-retention] ${DRY_RUN ? "DRY RUN, would change" : "changed"}: ` +
          `${result.sessionsMarkedExpired} negotiation(s) marked expired, ` +
          `${result.sessionsScrubbed} negotiation(s) had shopper ids removed, ` +
          `${result.rateLimitRowsDeleted} rate-limit row(s) deleted`,
      );
    }
  } catch (err) {
    // Must never throw out of here: an unhandled rejection would crash the
    // whole app process.
    console.error(
      "[data-retention] run failed:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    running = false;
  }
}

// Called once from entry.server.tsx when the server process loads. Runs in
// production, or locally only if DATA_RETENTION_ENABLED=true, so a normal
// `npm run dev` never touches the local database by accident. The globalThis
// flag keeps dev hot-reloads from stacking up duplicate timers.
export function startDataRetention(): void {
  const g = globalThis as typeof globalThis & {
    __noodleDataRetentionStarted?: boolean;
  };
  if (g.__noodleDataRetentionStarted) return;

  const enabled =
    process.env.NODE_ENV === "production" ||
    process.env.DATA_RETENTION_ENABLED === "true";
  if (!enabled) return;
  g.__noodleDataRetentionStarted = true;

  console.log(
    `[data-retention] scheduled every ${RUN_EVERY_MS / 60000} minutes, mode: ${
      DRY_RUN ? "DRY RUN (changes nothing)" : "LIVE (removes data)"
    }`,
  );

  setTimeout(() => {
    void runScheduled();
    setInterval(() => void runScheduled(), RUN_EVERY_MS).unref();
  }, FIRST_RUN_DELAY_MS).unref();
}
