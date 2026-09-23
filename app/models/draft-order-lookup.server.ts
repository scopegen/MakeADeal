import type { DraftOrderState } from "./draft-conversion";

// Shared core for reading draft order state from Shopify, used by both the
// internal (Scopegen-only) stats pages and the merchant-facing Negotiations
// page. draft-conversion.ts stays pure/import-free on purpose (so its
// classification logic can be tested with no network involved) - this file
// is where the actual Admin API call lives, split out so it's written and
// tested once rather than duplicated per caller.
//
// Needs only read_draft_orders, no access to orders.

// Same minimal structural type used elsewhere in this codebase, rather than
// depending on an exact exported type name from the Shopify package.
export type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type DraftStatesResult = {
  // Keyed by draft order id. A null value means Shopify returned nothing for
  // that id (deleted or unreadable). An id that is absent from the map was
  // never looked up at all, which is a different thing.
  states: Map<string, DraftOrderState | null>;
  error: string | null;
};

// Reads status, tags, and completion date of the given draft orders through
// an already-authenticated Admin GraphQL client. Batched 100 ids per call,
// matched back to the requested ids by id (not by result position), so this
// never depends on Shopify returning nodes in the order they were asked for.
export async function lookupDraftOrderStates(
  admin: AdminGraphqlClient,
  draftOrderIds: string[],
): Promise<DraftStatesResult> {
  const states = new Map<string, DraftOrderState | null>();
  if (draftOrderIds.length === 0) return { states, error: null };

  try {
    for (let i = 0; i < draftOrderIds.length; i += 100) {
      const chunk = draftOrderIds.slice(i, i + 100);
      const response = await admin.graphql(
        `#graphql
        query NoodleDraftOrderStates($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on DraftOrder {
              id
              status
              tags
              completedAt
            }
          }
        }`,
        { variables: { ids: chunk } },
      );
      const json = (await response.json()) as {
        data?: {
          nodes: (
            | {
                id: string;
                status: string;
                tags: string[];
                completedAt: string | null;
              }
            | null
          )[];
        };
        errors?: { message: string }[];
      };
      if (!json.data) {
        throw new Error(
          json.errors?.map((e) => e.message).join("; ") ?? "no data returned",
        );
      }
      const found = new Map<string, DraftOrderState>();
      for (const node of json.data.nodes) {
        if (node && node.id) {
          found.set(node.id, {
            status: node.status,
            tags: node.tags,
            completedAt: node.completedAt ? new Date(node.completedAt) : null,
          });
        }
      }
      for (const id of chunk) states.set(id, found.get(id) ?? null);
    }
    return { states, error: null };
  } catch (err) {
    // A failed lookup must not be read as "not converted": return whatever
    // was fetched before the failure, and let the caller flag the error.
    return {
      states,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
