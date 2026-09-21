// Decides whether an accepted negotiation turned into a real order, judged
// from the state of the draft order the negotiation created.
//
// The rule: a draft order counts as CONVERTED only if it is COMPLETED and
// still carries the "Noodle" tag. The tag is what proves it came from a Noodle
// negotiation (see createNegotiatedDraftOrder in negotiation-engine.server.ts).
// Draft orders are deliberately never deleted by the app: they stay in the
// merchant's Admin as a record, whether or not they were ever paid.
//
// Kept as its own file with no imports so it can be tested on its own.
//
// Shopify's DraftOrderStatus has exactly three values: OPEN, INVOICE_SENT, and
// COMPLETED ("The draft order has been paid"). Reading these needs only
// read_draft_orders, no access to orders.

export const CONVERSION_TAG = "Noodle";

export type ConversionState =
  // COMPLETED and tagged Noodle: counts as a conversion.
  | "converted"
  // COMPLETED but no Noodle tag: drafts from before the tag existed
  // (before Sept 18, 2026). Completed, but not counted as converted.
  | "completed_untagged"
  | "open"
  | "invoice_sent"
  // Shopify returned nothing for this id: the draft was deleted (the app
  // never deletes them, so by a merchant), or it isn't readable.
  | "not_found"
  // Any status Shopify adds in future that we don't know about yet.
  | "other";

// completedAt is when the draft order became an order (Shopify's own
// DraftOrder.completedAt, readable with read_draft_orders). Null for a draft
// that isn't completed.
export type DraftOrderState = {
  status: string;
  tags: string[];
  completedAt: Date | null;
};

export function classifyDraftOrder(
  draft: DraftOrderState | null | undefined,
): ConversionState {
  if (!draft) return "not_found";

  // Tags are case-insensitive in Shopify. Exact match, not "contains".
  const tagged = draft.tags.some(
    (t) => t.toLowerCase() === CONVERSION_TAG.toLowerCase(),
  );

  switch (draft.status) {
    case "COMPLETED":
      return tagged ? "converted" : "completed_untagged";
    case "OPEN":
      return "open";
    case "INVOICE_SENT":
      return "invoice_sent";
    default:
      return "other";
  }
}

export type SalesWindow = { orders: number; value: number };

export type SalesWindows = {
  last24h: SalesWindow;
  last2d: SalesWindow;
  last7d: SalesWindow;
  last30d: SalesWindow;
  thisMonth: SalesWindow;
};

// One converted order: when it completed, and what it was worth. Value is the
// accepted negotiation price for one unit, so it excludes tax and shipping.
export type SaleItem = { completedAt: Date | null; value: number };

const WINDOW_KEYS = [
  "last24h",
  "last2d",
  "last7d",
  "last30d",
  "thisMonth",
] as const;

// Totals converted sales over rolling and calendar windows. A sale is dated by
// when its order was completed, not when the negotiation started, so a deal
// negotiated yesterday and paid today counts for today.
//   last24h / last2d / last7d / last30d: rolling, counted back from now
//   (2 days is 48 hours).
//   thisMonth: since midnight UTC on the 1st of the current month.
export function salesByWindow(
  items: SaleItem[],
  now: Date = new Date(),
): SalesWindows {
  const nowMs = now.getTime();
  const hourMs = 60 * 60 * 1000;
  const cutoffs: Record<(typeof WINDOW_KEYS)[number], number> = {
    last24h: nowMs - 24 * hourMs,
    last2d: nowMs - 48 * hourMs,
    last7d: nowMs - 7 * 24 * hourMs,
    last30d: nowMs - 30 * 24 * hourMs,
    thisMonth: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  };

  const result: SalesWindows = {
    last24h: { orders: 0, value: 0 },
    last2d: { orders: 0, value: 0 },
    last7d: { orders: 0, value: 0 },
    last30d: { orders: 0, value: 0 },
    thisMonth: { orders: 0, value: 0 },
  };

  for (const item of items) {
    // A completed draft with no completion date can't be placed in a window.
    if (!item.completedAt) continue;
    const at = item.completedAt.getTime();
    for (const key of WINDOW_KEYS) {
      if (at >= cutoffs[key]) {
        result[key].orders += 1;
        result[key].value += item.value;
      }
    }
  }

  // Avoid float noise like 1234.5600000000002 in the display.
  for (const key of WINDOW_KEYS) {
    result[key].value = Math.round(result[key].value * 100) / 100;
  }
  return result;
}
