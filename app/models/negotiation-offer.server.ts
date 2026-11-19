import type { NegotiationSession } from "@prisma/client";
import prisma from "../db.server";
import { createNegotiatedDraftOrder } from "./negotiation-engine.server";
import type { AdminGraphqlClient } from "./draft-order-lookup.server";
import {
  classifySegment,
  evaluateSegmentedOffer,
  getAcceptedAtListPriceMessage,
  getAcceptedMessage,
  getNoPriceMessage,
  getSuggestionsMessage,
} from "./negotiation-tiers.server";
import { getDeclinedMessage } from "./negotiation-copy.server";
import {
  findSuggestions,
  type SuggestionsMatch,
} from "./product-suggestions.server";

// The longest a reply will wait on product suggestions before going out
// without them. Shopify doesn't publish the app proxy's own timeout, and
// this codebase has seen three sequential Admin API calls be enough to hit
// it (see acceptAt below), so this stays well clear of it.
const SUGGESTIONS_DEADLINE_MS = 3000;

// The decision for one customer action on an already-loaded, already-
// validated session (owned by the shop, not expired, ACTIVE, limits still
// resolvable). Shared by /offer (every message after the first) and /start
// (the shopper's first message, handled in the same request that creates the
// session - see proxy.start.tsx), so both behave identically.
//
// Returns a plain Response so each caller can pass it straight back (or, for
// /start, read its JSON and embed it).
export async function processNegotiationAction({
  admin,
  negotiationSession,
  limits,
  action,
  offerPriceRaw,
}: {
  admin: AdminGraphqlClient;
  negotiationSession: NegotiationSession;
  limits: { maxDiscountPercent: number; floorPriceOverride: number | null };
  action: string;
  offerPriceRaw: FormDataEntryValue | null;
}): Promise<Response> {
  const startingPrice = Number(negotiationSession.startingPrice);

  async function acceptAt(price: number, atOrAboveListPrice = false) {
    let draftOrder: { id: string; invoiceUrl: string };
    try {
      // Both cached on the session at /start - no extra API round-trip
      // needed here beyond the draftOrderCreate call itself. See the
      // schema comment on NegotiationSession.currencyCode for why this
      // matters: accept used to make three sequential Admin API calls,
      // which was the actual cause of it timing out through the app-proxy
      // layer under normal latency.
      draftOrder = await createNegotiatedDraftOrder(
        admin,
        negotiationSession.variantId,
        price,
        negotiationSession.currencyCode,
        negotiationSession.id,
      );
    } catch (err) {
      return Response.json(
        { error: "draft_order_failed", detail: String(err) },
        { status: 502 },
      );
    }

    await prisma.negotiationSession.update({
      where: { id: negotiationSession.id },
      data: {
        status: "ACCEPTED",
        currentOfferPrice: price,
        draftOrderId: draftOrder.id,
        draftOrderExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      },
    });

    return Response.json({
      status: "ACCEPTED",
      message: atOrAboveListPrice
        ? getAcceptedAtListPriceMessage(price)
        : getAcceptedMessage(price),
      price,
      checkoutUrl: draftOrder.invoiceUrl,
    });
  }

  // Product suggestions, at most once per session - at the first held floor
  // or at "No deal", whichever comes first. null means don't show any: off
  // for this shop, already shown this session, or the lookup failed or ran
  // out of time. Only looked up at those two moments, never earlier, since
  // it's several real Shopify queries and most sessions reach neither. A
  // failed or slow lookup is logged and skipped rather than thrown or waited
  // out: a suggestion is a bonus, and it must never break - or hold up past
  // the app proxy's patience - the decline or floor-held reply it rides
  // along with. null also leaves suggestionsShown false, so the next held
  // floor can try again.
  async function lookUpSuggestionsOnce(
    offerPrice: number,
  ): Promise<SuggestionsMatch | null> {
    if (negotiationSession.suggestionsShown) return null;
    const shop = await prisma.shop.findUnique({
      where: { id: negotiationSession.shopId },
      select: { suggestionsEnabled: true, suggestionsIgnoredCollectionIds: true },
    });
    if (!shop?.suggestionsEnabled) return null;

    const lookup = findSuggestions(admin, {
      productId: negotiationSession.productId,
      offerPrice,
      originalPrice: startingPrice,
      ignoredCollectionIds: shop.suggestionsIgnoredCollectionIds,
    });
    // Once the deadline wins, nothing awaits the lookup any more - this keeps
    // a failure it hits afterwards from surfacing as an unhandled rejection.
    lookup.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), SUGGESTIONS_DEADLINE_MS);
    });
    try {
      const result = await Promise.race([lookup, deadline]);
      if (result === "timed_out") {
        console.warn(
          `[negotiation-offer] product suggestions took over ${SUGGESTIONS_DEADLINE_MS}ms, skipped`,
        );
        return null;
      }
      return result;
    } catch (err) {
      console.error("[negotiation-offer] product suggestions failed", err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  if (action === "decline") {
    // Search under the shopper's own last offer first - that's the budget
    // they told us. No offer on record (shouldn't happen, "No deal" only
    // appears under a final offer) falls through to 0, which skips straight
    // to products under the original price.
    let suggestions: SuggestionsMatch | null = null;
    if (!negotiationSession.suggestionsShown) {
      const lastOffer = await prisma.negotiationOffer.findFirst({
        where: {
          sessionId: negotiationSession.id,
          actor: "CUSTOMER",
          offerPrice: { not: null },
        },
        orderBy: { createdAt: "desc" },
        select: { offerPrice: true },
      });
      suggestions = await lookUpSuggestionsOnce(Number(lastOffer?.offerPrice ?? 0));
    }
    const suggestionsMessage = suggestions
      ? getSuggestionsMessage("declined", suggestions.kind)
      : null;

    await prisma.negotiationSession.update({
      where: { id: negotiationSession.id },
      data: {
        status: "DECLINED",
        suggestionsShown: negotiationSession.suggestionsShown || suggestions !== null,
      },
    });
    // message stays the plain goodbye either way, so a widget build that
    // predates suggestions still shows something sensible. A widget that
    // knows about suggestions shows suggestions.message plus the cards
    // INSTEAD of message when products came back.
    return Response.json({
      status: "DECLINED",
      message: getDeclinedMessage(),
      suggestions:
        suggestions && suggestions.kind !== "none" && suggestionsMessage
          ? { message: suggestionsMessage, products: suggestions.products }
          : null,
    });
  }

  if (action === "accept") {
    if (negotiationSession.currentOfferPrice === null) {
      return Response.json({ error: "nothing_to_accept" }, { status: 400 });
    }
    return acceptAt(Number(negotiationSession.currentOfferPrice));
  }

  if (action === "counter") {
    const offerPrice = Number(offerPriceRaw);
    // No parseable price in the message - doesn't consume a round or error
    // out, just asks conversationally for one. Doesn't touch currentRound
    // or segment at all, so a chatty "hi"/"maybe" reply before any real
    // offer costs nothing.
    if (!offerPriceRaw || !Number.isFinite(offerPrice) || offerPrice <= 0) {
      return Response.json({ status: "ACTIVE", message: getNoPriceMessage() });
    }

    // Classified once, on the first valid offer only - never reassigned
    // afterward even if a later offer would classify differently. See the
    // schema comment on NegotiationSession.segment.
    let segment = negotiationSession.segment;
    if (!segment) {
      const percentFloor =
        startingPrice * (1 - limits.maxDiscountPercent / 100);
      const floorPrice =
        limits.floorPriceOverride !== null
          ? Math.max(percentFloor, limits.floorPriceOverride)
          : percentFloor;
      const maxDiscountAmount = startingPrice * (limits.maxDiscountPercent / 100);
      segment = classifySegment(offerPrice, floorPrice, maxDiscountAmount);
      await prisma.negotiationSession.update({
        where: { id: negotiationSession.id },
        data: { segment },
      });
    }

    const evaluation = evaluateSegmentedOffer(
      segment,
      startingPrice,
      limits.maxDiscountPercent,
      limits.floorPriceOverride,
      negotiationSession.currentRound,
      offerPrice,
    );

    await prisma.negotiationOffer.create({
      data: {
        sessionId: negotiationSession.id,
        round: negotiationSession.currentRound + 1,
        actor: "CUSTOMER",
        offerPrice,
      },
    });

    if (evaluation.outcome === "ACCEPTED") {
      await prisma.negotiationOffer.create({
        data: {
          sessionId: negotiationSession.id,
          round: negotiationSession.currentRound + 1,
          actor: "BOT",
          offerPrice: evaluation.price,
          messageText: "accepted",
        },
      });
      return acceptAt(evaluation.price, evaluation.atOrAboveListPrice);
    }

    if (evaluation.outcome === "ASK_FOR_MORE") {
      // No price attached - only reachable at tier 1 of Can-Be-Converted/
      // Too-Low (see the noPrice flag on Tier in negotiation-tiers.server).
      // Advances the round so the next real offer lands on tier 2, but
      // there's nothing to log as an offer price or set as currentOfferPrice
      // yet.
      await prisma.negotiationSession.update({
        where: { id: negotiationSession.id },
        data: { currentRound: evaluation.round },
      });
      await prisma.negotiationOffer.create({
        data: {
          sessionId: negotiationSession.id,
          round: evaluation.round,
          actor: "BOT",
          messageText: evaluation.message,
        },
      });
      return Response.json({
        status: "ACTIVE",
        message: evaluation.message,
        round: evaluation.round,
      });
    }

    if (evaluation.outcome === "FLOOR_HELD") {
      // currentRound still advances by one each turn even though the
      // segment's tier table is exhausted (evaluateSegmentedOffer keeps
      // returning the same floor price regardless) - purely so the offer
      // history log shows a monotonically increasing round number per
      // exchange, not repeats.
      const nextRound = negotiationSession.currentRound + 1;

      const suggestions = await lookUpSuggestionsOnce(offerPrice);

      await prisma.negotiationSession.update({
        where: { id: negotiationSession.id },
        data: {
          currentRound: nextRound,
          currentOfferPrice: evaluation.price,
          // Flips true once a lookup has run, whether or not it found
          // anything - a "nothing available" reply still used up this
          // session's one chance. Stays false while suggestions are off,
          // so turning them on mid-conversation can still take effect.
          suggestionsShown: negotiationSession.suggestionsShown || suggestions !== null,
        },
      });
      await prisma.negotiationOffer.create({
        data: {
          sessionId: negotiationSession.id,
          round: nextRound,
          actor: "BOT",
          offerPrice: evaluation.price,
          messageText: evaluation.message,
        },
      });
      return Response.json({
        status: "ACTIVE",
        floorReached: true,
        message: evaluation.message,
        price: evaluation.price,
        // products is [] for the "nothing available" case, which still
        // carries its own message (plain text, no carousel).
        suggestions: suggestions
          ? {
              message: getSuggestionsMessage("floor_held", suggestions.kind) ?? "",
              products: suggestions.kind === "none" ? [] : suggestions.products,
            }
          : null,
      });
    }

    // COUNTERED
    await prisma.negotiationSession.update({
      where: { id: negotiationSession.id },
      data: {
        currentRound: evaluation.round,
        currentOfferPrice: evaluation.price,
      },
    });
    await prisma.negotiationOffer.create({
      data: {
        sessionId: negotiationSession.id,
        round: evaluation.round,
        actor: "BOT",
        offerPrice: evaluation.price,
        messageText: evaluation.message,
      },
    });
    return Response.json({
      status: "ACTIVE",
      message: evaluation.message,
      price: evaluation.price,
      round: evaluation.round,
      finalTier: evaluation.isFinalTier,
    });
  }

  return Response.json({ error: "unknown_action" }, { status: 400 });
}
