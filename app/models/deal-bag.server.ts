import type { DealBag, NegotiationSession } from "@prisma/client";
import prisma from "../db.server";
import type { AdminGraphqlClient } from "./draft-order-lookup.server";
import { getPriceDisplay, type PriceDisplay } from "./price-display.server";
import {
  dealMessage,
  extraDiscountFor,
  formatPercent,
  MAX_DEAL_ITEMS,
  type DealSettings,
} from "./deal-bag-copy";

// Multi-product deals (Shop.multiDealsEnabled). Instead of every accepted
// deal getting its own draft order, a shopper's deals go into one shared
// draft order - their "deal bag" - so one checkout pays for everything:
//
// - Negotiating another product and agreeing a price adds it to the bag's
//   draft order (draftOrderUpdate replaces the line items with the full new
//   list). The checkout link stays the bag's own, so an older link the
//   shopper still has open shows the whole bag too.
// - Re-negotiating a variant that's already in the bag replaces its earlier
//   deal rather than adding a second one.
// - The merchant's optional extra discount for buying several products (see
//   deal-bag-copy.ts) goes on the draft order as one order-level discount,
//   recalculated every time the bag changes - removing a deal can lower it.
// - A bag is kept for 48 hours after its last deal. A bag whose draft order
//   was completed (paid), deleted in the admin, or emptied is finished, and
//   the next deal starts a new one.
//
// Everything is in the store's currency, like the rest of the negotiation;
// the view sent to the widget is converted for display only.

const DEAL_BAG_MS = 48 * 60 * 60 * 1000;

export type Shopper = { customerId: string | null; anonymousId: string | null };

// Who's asking, from an app-proxy request. logged_in_customer_id is added by
// Shopify itself (trusted); the anonymous id is the widget's own random
// browser id (see getAnonymousId in widget.tsx), sent with every request.
// Only its known shape is accepted.
export function shopperFrom(request: Request, anonymousIdRaw: unknown): Shopper {
  const loggedIn = new URL(request.url).searchParams.get("logged_in_customer_id");
  const anonymousId =
    typeof anonymousIdRaw === "string" &&
    /^anon_[0-9a-z_]{1,100}$/i.test(anonymousIdRaw)
      ? anonymousIdRaw
      : null;
  return {
    customerId: loggedIn ? `gid://shopify/Customer/${loggedIn}` : null,
    anonymousId,
  };
}

export async function getDealSettings(
  shopId: string,
): Promise<(DealSettings & { multiDealsEnabled: boolean }) | null> {
  return prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      multiDealsEnabled: true,
      multiDealDiscounts: true,
      multiDealSavedMessage: true,
      multiDealNextMessage: true,
    },
  });
}

type BagWithDeals = DealBag & { sessions: NegotiationSession[] };

// The shopper's open bag, with its deals in the order they were made. Found
// by either id, so a shopper who logs in partway still finds the bag they
// started anonymously.
export async function findOpenBag(
  shopId: string,
  shopper: Shopper,
): Promise<BagWithDeals | null> {
  const owners = [
    ...(shopper.customerId ? [{ customerId: shopper.customerId }] : []),
    ...(shopper.anonymousId ? [{ anonymousId: shopper.anonymousId }] : []),
  ];
  if (owners.length === 0) return null;
  return prisma.dealBag.findFirst({
    where: {
      shopId,
      status: "OPEN",
      expiresAt: { gt: new Date() },
      OR: owners,
    },
    orderBy: { updatedAt: "desc" },
    include: {
      sessions: {
        where: { status: "ACCEPTED" },
        orderBy: { createdAt: "asc" },
      },
    },
  });
}

type Deal = { sessionId: string; variantId: string; price: number };

function toDeal(session: NegotiationSession): Deal {
  return {
    sessionId: session.id,
    variantId: session.variantId,
    price: Number(session.currentOfferPrice),
  };
}

// What the chat's "Your deals" list shows for each draft order line - read
// back from Shopify rather than stored, so it's always the current title.
type DraftLine = {
  variantId: string;
  title: string;
  variantTitle: string | null;
  imageUrl: string | null;
};

type DraftOrderResult = {
  id: string;
  status: string;
  invoiceUrl: string;
  lines: DraftLine[];
};

type DraftOrderNode = {
  id: string;
  status: string;
  invoiceUrl: string;
  lineItems: {
    nodes: {
      variant: { id: string; title: string } | null;
      product: {
        title: string;
        featuredMedia: { preview: { image: { url: string } | null } | null } | null;
      } | null;
    }[];
  };
};

const DRAFT_ORDER_FIELDS = `
          id
          status
          invoiceUrl
          lineItems(first: ${MAX_DEAL_ITEMS + 5}) {
            nodes {
              variant {
                id
                title
              }
              product {
                title
                featuredMedia {
                  preview {
                    image {
                      url
                    }
                  }
                }
              }
            }
          }`;

function toResult(node: DraftOrderNode): DraftOrderResult {
  return {
    id: node.id,
    status: node.status,
    invoiceUrl: node.invoiceUrl,
    lines: node.lineItems.nodes.flatMap((line) =>
      line.variant
        ? [
            {
              variantId: line.variant.id,
              title: line.product?.title ?? "",
              // Shopify's name for the only variant of a product with no
              // options - nothing worth showing.
              variantTitle:
                line.variant.title && line.variant.title !== "Default Title"
                  ? line.variant.title
                  : null,
              imageUrl:
                line.product?.featuredMedia?.preview?.image?.url ?? null,
            },
          ]
        : [],
    ),
  };
}

function draftOrderInput(
  deals: Deal[],
  extraDiscountPercent: number,
  currencyCode: string,
) {
  return {
    lineItems: deals.map((deal) => ({
      variantId: deal.variantId,
      quantity: 1,
      priceOverride: { amount: deal.price.toFixed(2), currencyCode },
    })),
    // One order-level discount for the whole bag, shown as its own line at
    // checkout. null takes an earlier one off again (e.g. after a removal).
    appliedDiscount:
      extraDiscountPercent > 0
        ? {
            value: extraDiscountPercent,
            valueType: "PERCENTAGE",
            title: `Multi-product deal: ${formatPercent(extraDiscountPercent)} off`,
          }
        : null,
    note: `Negotiated via Scopegen Negotiator - multi-product deal, sessions ${deals
      .map((d) => d.sessionId)
      .join(", ")}`,
    // Same tag as a single deal's draft order - see createNegotiatedDraftOrder
    // in negotiation-engine.server.ts for why it matters.
    tags: ["Noodle"],
  };
}

async function createBagDraftOrder(
  admin: AdminGraphqlClient,
  input: ReturnType<typeof draftOrderInput>,
): Promise<DraftOrderResult> {
  const response = await admin.graphql(
    `#graphql
    mutation NoodleDealBagCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {${DRAFT_ORDER_FIELDS}
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { variables: { input } },
  );
  const json = (await response.json()) as {
    data?: {
      draftOrderCreate: {
        draftOrder: DraftOrderNode | null;
        userErrors: { message: string }[];
      };
    };
  };
  const result = json.data?.draftOrderCreate;
  if (!result || result.userErrors.length > 0 || !result.draftOrder) {
    throw new Error(
      result?.userErrors.map((e) => e.message).join("; ") ||
        "draftOrderCreate returned no draft order",
    );
  }
  return toResult(result.draftOrder);
}

// null when Shopify won't update it (already completed, deleted in the
// admin, ...) - the caller then treats the bag as finished. A network or
// server failure still throws, so a shopper's retry doesn't quietly start a
// second bag.
async function updateBagDraftOrder(
  admin: AdminGraphqlClient,
  draftOrderId: string,
  input: ReturnType<typeof draftOrderInput>,
): Promise<DraftOrderResult | null> {
  const response = await admin.graphql(
    `#graphql
    mutation NoodleDealBagUpdate($id: ID!, $input: DraftOrderInput!) {
      draftOrderUpdate(id: $id, input: $input) {
        draftOrder {${DRAFT_ORDER_FIELDS}
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { variables: { id: draftOrderId, input } },
  );
  const json = (await response.json()) as {
    data?: {
      draftOrderUpdate: {
        draftOrder: DraftOrderNode | null;
        userErrors: { message: string }[];
      } | null;
    };
  };
  const result = json.data?.draftOrderUpdate;
  if (!result || result.userErrors.length > 0 || !result.draftOrder) {
    return null;
  }
  if (result.draftOrder.status === "COMPLETED") return null;
  return toResult(result.draftOrder);
}

async function readBagDraftOrder(
  admin: AdminGraphqlClient,
  draftOrderId: string,
): Promise<DraftOrderResult | null> {
  const response = await admin.graphql(
    `#graphql
    query NoodleDealBag($id: ID!) {
      draftOrder(id: $id) {${DRAFT_ORDER_FIELDS}
      }
    }`,
    { variables: { id: draftOrderId } },
  );
  const json = (await response.json()) as {
    data?: { draftOrder: DraftOrderNode | null };
  };
  const node = json.data?.draftOrder;
  return node ? toResult(node) : null;
}

// Best effort: an emptied bag's draft order is just clutter in the
// merchant's Drafts list. Failing to delete it changes nothing for anyone.
async function deleteBagDraftOrder(
  admin: AdminGraphqlClient,
  draftOrderId: string,
) {
  try {
    await admin.graphql(
      `#graphql
      mutation NoodleDealBagDelete($input: DraftOrderDeleteInput!) {
        draftOrderDelete(input: $input) {
          deletedId
          userErrors {
            message
          }
        }
      }`,
      { variables: { input: { id: draftOrderId } } },
    );
  } catch (err) {
    console.warn("[deal-bag] couldn't delete an emptied bag's draft order", err);
  }
}

// What the widget's "Your deals" list shows. Prices are in the currency the
// shopper is looking at (see price-display.server.ts); the bag itself is in
// the store's.
export type DealBagView = {
  items: {
    sessionId: string;
    productTitle: string;
    variantTitle: string | null;
    imageUrl: string | null;
    price: number;
  }[];
  currencyCode: string;
  subtotal: number;
  extraDiscountPercent: number;
  total: number;
  checkoutUrl: string;
  full: boolean;
};

function buildView(
  deals: Deal[],
  lines: DraftLine[],
  extraDiscountPercent: number,
  checkoutUrl: string,
  display: PriceDisplay,
  storeCurrencyCode: string,
): DealBagView {
  const lineFor = new Map(lines.map((line) => [line.variantId, line]));
  const subtotal = deals.reduce((sum, deal) => sum + deal.price, 0);
  const total =
    Math.round(subtotal * (1 - extraDiscountPercent / 100) * 100) / 100;
  return {
    items: deals.map((deal) => {
      const line = lineFor.get(deal.variantId);
      return {
        sessionId: deal.sessionId,
        productTitle: line?.title || "Product",
        variantTitle: line?.variantTitle ?? null,
        imageUrl: line?.imageUrl ?? null,
        price: display.toDisplay(deal.price),
      };
    }),
    currencyCode: display.currencyCode ?? storeCurrencyCode,
    subtotal: display.toDisplay(subtotal),
    extraDiscountPercent,
    total: display.toDisplay(total),
    checkoutUrl,
    full: deals.length >= MAX_DEAL_ITEMS,
  };
}

// Whether a new negotiation can still end up in the shopper's bag. False
// only when the bag is full and this variant isn't already in it (a
// re-negotiation replaces its deal, so it never grows the bag).
export async function bagHasRoomFor(
  shopId: string,
  shopper: Shopper,
  variantId: string | null,
): Promise<boolean> {
  const bag = await findOpenBag(shopId, shopper);
  if (!bag || bag.sessions.length < MAX_DEAL_ITEMS) return true;
  return variantId !== null && bag.sessions.some((s) => s.variantId === variantId);
}

// An accepted deal, into the shopper's bag (a new bag if they have none
// open). Called by acceptAt in negotiation-offer.server.ts in place of a
// single-deal draft order; the caller then marks the session ACCEPTED with
// the returned bagId and draftOrderId.
export async function addDealToBag(
  admin: AdminGraphqlClient,
  {
    shopId,
    settings,
    shopper,
    session,
    price,
    display,
  }: {
    shopId: string;
    settings: DealSettings;
    shopper: Shopper;
    session: NegotiationSession;
    price: number;
    display: PriceDisplay;
  },
): Promise<{
  bagId: string;
  draftOrderId: string;
  checkoutUrl: string;
  view: DealBagView;
  message: string;
}> {
  // An older cached widget doesn't send its id with /offer - the session's
  // own ids are the same shopper.
  const owner: Shopper =
    shopper.customerId || shopper.anonymousId
      ? shopper
      : { customerId: session.customerId, anonymousId: session.anonymousId };
  const currencyCode = session.currencyCode;
  const thisDeal: Deal = {
    sessionId: session.id,
    variantId: session.variantId,
    price,
  };
  const expiresAt = new Date(Date.now() + DEAL_BAG_MS);

  const bag = await findOpenBag(shopId, owner);
  if (bag) {
    const others = bag.sessions.filter((s) => s.id !== session.id);
    const kept = others.filter((s) => s.variantId !== session.variantId);
    const replaced = others.filter((s) => s.variantId === session.variantId);
    const deals = [...kept.map(toDeal), thisDeal];

    // A full bag (only reachable through a race - /start refuses new
    // negotiations once it's full) is left as it is, and this deal starts a
    // new one below.
    if (deals.length <= MAX_DEAL_ITEMS) {
      const extraDiscountPercent = extraDiscountFor(
        settings.multiDealDiscounts,
        deals.length,
      );
      const draft = await updateBagDraftOrder(
        admin,
        bag.draftOrderId,
        draftOrderInput(deals, extraDiscountPercent, currencyCode),
      );
      if (draft) {
        await prisma.$transaction([
          prisma.dealBag.update({
            where: { id: bag.id },
            data: {
              extraDiscountPercent,
              checkoutUrl: draft.invoiceUrl,
              expiresAt,
              customerId: bag.customerId ?? owner.customerId,
              anonymousId: bag.anonymousId ?? owner.anonymousId,
            },
          }),
          // The deal this one replaces is no longer in the draft order, so
          // it must not count as a sale when the order is paid.
          prisma.negotiationSession.updateMany({
            where: { id: { in: replaced.map((s) => s.id) } },
            data: { dealBagId: null, draftOrderId: null },
          }),
        ]);
        return {
          bagId: bag.id,
          draftOrderId: draft.id,
          checkoutUrl: draft.invoiceUrl,
          view: buildView(
            deals,
            draft.lines,
            extraDiscountPercent,
            draft.invoiceUrl,
            display,
            currencyCode,
          ),
          message: dealMessage("saved", settings, deals.length),
        };
      }
      // Paid already, or deleted in the admin - either way this bag is done.
      await prisma.dealBag.update({
        where: { id: bag.id },
        data: { status: "CLOSED" },
      });
    }
  }

  const deals = [thisDeal];
  const extraDiscountPercent = extraDiscountFor(settings.multiDealDiscounts, 1);
  const draft = await createBagDraftOrder(
    admin,
    draftOrderInput(deals, extraDiscountPercent, currencyCode),
  );
  const created = await prisma.dealBag.create({
    data: {
      shopId,
      customerId: owner.customerId,
      anonymousId: owner.anonymousId,
      draftOrderId: draft.id,
      checkoutUrl: draft.invoiceUrl,
      extraDiscountPercent,
      expiresAt,
    },
  });
  return {
    bagId: created.id,
    draftOrderId: draft.id,
    checkoutUrl: draft.invoiceUrl,
    view: buildView(
      deals,
      draft.lines,
      extraDiscountPercent,
      draft.invoiceUrl,
      display,
      currencyCode,
    ),
    message: dealMessage("saved", settings, 1),
  };
}

// The shopper's "Remove" in the chat's deal list. The session keeps its
// ACCEPTED status (they did agree that price) but leaves the bag and its
// draft order, so it never counts as a sale. ok: false when there's nothing
// of theirs to remove, or the draft order can no longer be changed (already
// paid, for example).
//
// displayParams: as for loadBagForPage.
export async function removeDealFromBag(
  admin: AdminGraphqlClient,
  {
    shopId,
    settings,
    shopper,
    sessionId,
    displayParams,
  }: {
    shopId: string;
    settings: DealSettings;
    shopper: Shopper;
    sessionId: string;
    displayParams: Parameters<typeof getPriceDisplay>[0];
  },
): Promise<{ ok: true; view: DealBagView | null } | { ok: false }> {
  const bag = await findOpenBag(shopId, shopper);
  const target = bag?.sessions.find((s) => s.id === sessionId);
  if (!bag || !target) return { ok: false };
  const display = getPriceDisplay(displayParams, target.currencyCode);

  const leaveBag = prisma.negotiationSession.update({
    where: { id: target.id },
    data: { dealBagId: null, draftOrderId: null },
  });
  const rest = bag.sessions.filter((s) => s.id !== sessionId);

  if (rest.length === 0) {
    await deleteBagDraftOrder(admin, bag.draftOrderId);
    await prisma.$transaction([
      prisma.dealBag.update({
        where: { id: bag.id },
        data: { status: "CLOSED", extraDiscountPercent: 0 },
      }),
      leaveBag,
    ]);
    return { ok: true, view: null };
  }

  const deals = rest.map(toDeal);
  const extraDiscountPercent = extraDiscountFor(
    settings.multiDealDiscounts,
    deals.length,
  );
  const currencyCode = target.currencyCode;
  const draft = await updateBagDraftOrder(
    admin,
    bag.draftOrderId,
    draftOrderInput(deals, extraDiscountPercent, currencyCode),
  );
  if (!draft) {
    await prisma.dealBag.update({
      where: { id: bag.id },
      data: { status: "CLOSED" },
    });
    return { ok: false };
  }
  await prisma.$transaction([
    prisma.dealBag.update({
      where: { id: bag.id },
      data: { extraDiscountPercent, checkoutUrl: draft.invoiceUrl },
    }),
    leaveBag,
  ]);
  return {
    ok: true,
    view: buildView(
      deals,
      draft.lines,
      extraDiscountPercent,
      draft.invoiceUrl,
      display,
      currencyCode,
    ),
  };
}

// The shopper's open bag for a product page (see proxy.eligibility.tsx):
// the deal list, plus the "you have N deals saved" message unless this
// product is already in the bag. Checks with Shopify that the draft order is
// still open - a shopper who has since paid doesn't see an old bag.
//
// displayParams: the request's displayCurrency/displayRate (see
// getPriceDisplay) - turned into a display here, since the store's currency
// is only known from the bag's own deals.
export async function loadBagForPage(
  admin: AdminGraphqlClient,
  {
    shopId,
    settings,
    shopper,
    productId,
    displayParams,
  }: {
    shopId: string;
    settings: DealSettings;
    shopper: Shopper;
    productId: string;
    displayParams: Parameters<typeof getPriceDisplay>[0];
  },
): Promise<{ view: DealBagView; message: string | null } | null> {
  const bag = await findOpenBag(shopId, shopper);
  if (!bag || bag.sessions.length === 0) return null;
  const storeCurrencyCode = bag.sessions[0].currencyCode;
  const display = getPriceDisplay(displayParams, storeCurrencyCode);

  const draft = await readBagDraftOrder(admin, bag.draftOrderId);
  if (!draft || draft.status === "COMPLETED") {
    await prisma.dealBag.update({
      where: { id: bag.id },
      data: { status: draft ? "CHECKED_OUT" : "CLOSED" },
    });
    return null;
  }

  const deals = bag.sessions.map(toDeal);
  const view = buildView(
    deals,
    draft.lines,
    Number(bag.extraDiscountPercent),
    draft.invoiceUrl,
    display,
    storeCurrencyCode,
  );
  const inBag = bag.sessions.some((s) => s.productId === productId);
  let message: string | null = null;
  if (!inBag) {
    message = view.full ? BAG_FULL_MESSAGE : dealMessage("next", settings, deals.length);
  }
  return { view, message };
}

// Fixed wording, not merchant-editable: it only ever shows after
// MAX_DEAL_ITEMS deals, which almost no shopper reaches.
export const BAG_FULL_MESSAGE = `You have ${MAX_DEAL_ITEMS} deals saved, the most one checkout can hold. Check out first, then come back for more deals.`;
