import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";

// Deletes abandoned negotiated draft orders. Every accepted negotiation
// creates a real Shopify draft order (see createNegotiatedDraftOrder in
// negotiation-engine.server.ts), and Shopify never expires an open draft
// order on its own - so a shopper who accepts a price and never pays leaves
// one sitting in the merchant's Admin forever. This clears them out.
//
// Deliberately narrow, because a deleted draft order is gone for good:
//   - only drafts tagged "Noodle" (the tag createNegotiatedDraftOrder sets),
//     so a merchant's own manually created draft orders are never touched
//   - only drafts still OPEN, so anything a merchant invoiced, completed, or
//     turned into an order is left alone
//   - only drafts created more than 24 hours ago
// Drafts created before the tag existed (before Sept 18, 2026) carry no tag,
// so they are never matched. Clear those by hand in Shopify Admin.
//
// Needs read_draft_orders + write_draft_orders, both already granted, so this
// is a backend-only change: no shopify app deploy, no new app version.

const TAG = "Noodle";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RUN_EVERY_MS = 60 * 60 * 1000;
// Small delay before the first run so it doesn't compete with the app's own
// startup work (migrations already ran before this process started, but the
// first requests are still arriving).
const FIRST_RUN_DELAY_MS = 60 * 1000;
// Safety cap per shop per run. A shop with more than this just gets the rest
// on the next hourly run, rather than one run doing an unbounded pile of deletes.
const MAX_HANDLED_PER_SHOP_PER_RUN = 100;

// DRY RUN: when true, this only LOGS what it would delete and deletes
// nothing. Ships as true on purpose. Watch the container logs for a day, and
// once the "would delete" lines are exactly the drafts you expect, flip this
// to false and redeploy.
const DRY_RUN = true;

// Same minimal structural type the negotiation engine uses, so this doesn't
// depend on an exact exported type name from the Shopify package.
type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type DraftOrderNode = {
  id: string;
  name: string;
  createdAt: string;
  status: string;
  tags: string[];
};

type OpenDraftsResponse = {
  data?: {
    draftOrders: {
      nodes: DraftOrderNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: { message: string }[];
};

type DeleteDraftResponse = {
  data?: {
    draftOrderDelete: {
      deletedId: string | null;
      userErrors: { field: string[]; message: string }[];
    };
  };
  errors?: { message: string }[];
};

// Asks Shopify for tagged + open drafts server-side, then re-checks tag,
// status, and age again in code below before anything is touched. The
// server-side search is only there to keep the list short; the in-code checks
// are what actually decide, because a deletion can't be undone.
const OPEN_DRAFTS_QUERY = `#graphql
  query NoodleOpenDraftOrders($cursor: String) {
    draftOrders(first: 100, after: $cursor, query: "tag:${TAG} status:open") {
      nodes {
        id
        name
        createdAt
        status
        tags
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

const DELETE_DRAFT_MUTATION = `#graphql
  mutation DeleteNoodleDraftOrder($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors {
        field
        message
      }
    }
  }`;

type ShopResult = { handled: number; errors: number };

async function cleanupShop(
  shopDomain: string,
  cutoffMs: number,
): Promise<ShopResult> {
  const result: ShopResult = { handled: 0, errors: 0 };

  // Works without a merchant or shopper being present: uses the shop's
  // stored offline access token. Throws if the shop has no usable token.
  const { admin } = (await unauthenticated.admin(shopDomain)) as {
    admin: AdminGraphqlClient;
  };

  let cursor: string | null = null;
  do {
    const response = await admin.graphql(OPEN_DRAFTS_QUERY, {
      variables: { cursor },
    });
    const json = (await response.json()) as OpenDraftsResponse;
    if (!json.data) {
      throw new Error(
        `draftOrders query failed: ${json.errors?.map((e) => e.message).join("; ") ?? "no data returned"}`,
      );
    }

    for (const draft of json.data.draftOrders.nodes) {
      if (result.handled >= MAX_HANDLED_PER_SHOP_PER_RUN) break;

      // The actual safety checks. Tag comparison is case-insensitive because
      // Shopify treats tags that way; it is an exact match, not "contains".
      if (draft.status !== "OPEN") continue;
      if (!draft.tags.some((t) => t.toLowerCase() === TAG.toLowerCase())) {
        continue;
      }
      if (new Date(draft.createdAt).getTime() > cutoffMs) continue;

      result.handled++;

      if (DRY_RUN) {
        console.log(
          `[draft-cleanup] DRY RUN, would delete ${draft.name} (${draft.id}) on ${shopDomain}, created ${draft.createdAt}`,
        );
        continue;
      }

      const deleteResponse = await admin.graphql(DELETE_DRAFT_MUTATION, {
        variables: { input: { id: draft.id } },
      });
      const deleteJson = (await deleteResponse.json()) as DeleteDraftResponse;
      const userErrors = deleteJson.data?.draftOrderDelete.userErrors ?? [];
      if (!deleteJson.data || userErrors.length > 0) {
        result.errors++;
        console.warn(
          `[draft-cleanup] could not delete ${draft.name} (${draft.id}) on ${shopDomain}: ${
            userErrors.map((e) => e.message).join("; ") ||
            deleteJson.errors?.map((e) => e.message).join("; ") ||
            "unknown error"
          }`,
        );
      } else {
        console.log(
          `[draft-cleanup] deleted ${draft.name} (${draft.id}) on ${shopDomain}, created ${draft.createdAt}`,
        );
      }
    }

    const { hasNextPage, endCursor } = json.data.draftOrders.pageInfo;
    cursor =
      hasNextPage && result.handled < MAX_HANDLED_PER_SHOP_PER_RUN
        ? endCursor
        : null;
  } while (cursor);

  return result;
}

let running = false;

async function runDraftOrderCleanup(): Promise<void> {
  // A slow run must never overlap with the next scheduled one.
  if (running) return;
  running = true;
  try {
    const cutoffMs = Date.now() - MAX_AGE_MS;
    const shops = await prisma.shop.findMany({
      where: { uninstalledAt: null },
      select: { shopDomain: true },
    });

    let handled = 0;
    let errors = 0;
    for (const { shopDomain } of shops) {
      // One shop failing (no usable token, API hiccup) must not stop the rest.
      try {
        const result = await cleanupShop(shopDomain, cutoffMs);
        handled += result.handled;
        errors += result.errors;
      } catch (err) {
        errors++;
        console.error(
          `[draft-cleanup] skipped ${shopDomain}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Only log a summary when something actually happened, so an idle hour
    // adds nothing to the container logs.
    if (handled > 0 || errors > 0) {
      console.log(
        `[draft-cleanup] run finished, shops checked: ${shops.length}, ${
          DRY_RUN ? "would delete" : "deleted"
        }: ${handled}, errors: ${errors}`,
      );
    }
  } catch (err) {
    // Must never throw out of here: an unhandled rejection would crash the
    // whole app process.
    console.error(
      "[draft-cleanup] run failed:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    running = false;
  }
}

// Called once from entry.server.tsx when the server process loads. Runs in
// production, or locally only if DRAFT_CLEANUP_ENABLED=true, so a normal
// `npm run dev` never touches a dev store's draft orders by accident.
// The globalThis flag keeps dev hot-reloads from stacking up duplicate timers.
export function startDraftOrderCleanup(): void {
  const g = globalThis as typeof globalThis & {
    __noodleDraftCleanupStarted?: boolean;
  };
  if (g.__noodleDraftCleanupStarted) return;

  const enabled =
    process.env.NODE_ENV === "production" ||
    process.env.DRAFT_CLEANUP_ENABLED === "true";
  if (!enabled) return;
  g.__noodleDraftCleanupStarted = true;

  console.log(
    `[draft-cleanup] scheduled every ${RUN_EVERY_MS / 60000} minutes, mode: ${
      DRY_RUN ? "DRY RUN (deletes nothing)" : "LIVE (deletes)"
    }`,
  );

  setTimeout(() => {
    void runDraftOrderCleanup();
    setInterval(() => void runDraftOrderCleanup(), RUN_EVERY_MS).unref();
  }, FIRST_RUN_DELAY_MS).unref();
}
